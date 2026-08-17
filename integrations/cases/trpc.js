// tRPC through @trpc/server/adapters/express: a router with a query, a mutation and an input that
// fails validation.
//
// The adapter reads req.query and req.body, writes with res.end, and sets its own status, so this
// covers a different corner of the response surface than the two cases beside it. The input
// validator is written by hand rather than with zod: one dependency fewer, same code path.

const { initTRPC, TRPCError } = require("@trpc/server");
const { createExpressMiddleware } = require("@trpc/server/adapters/express");
const { express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13803;

const t = initTRPC.context().create({
    // tRPC puts the stack in the error body outside production, and it names absolute paths and
    // frames that differ run to run. Dropping it leaves the code, the message and the status, which
    // is what the two arms are being compared on
    errorFormatter: ({ shape }) => ({ ...shape, data: { ...shape.data, stack: undefined } })
});

/**
 * The input every procedure here takes: `{ id: number }`, and a throw is a 400 from tRPC.
 *
 * @param {any} value whatever arrived on the wire
 * @returns {{id: number}}
 */
function withId(value) {
    if (typeof value?.id !== "number" || !Number.isInteger(value.id)) {
        throw new Error("id must be an integer");
    }
    return { id: value.id };
}

const items = new Map([
    [1, "primo"],
    [2, "secondo"]
]);

const appRouter = t.router({
    list: t.procedure.query(() => [...items].map(([id, name]) => ({ id, name }))),
    byId: t.procedure.input(withId).query(({ input }) => {
        const name = items.get(input.id);
        if (name === undefined) {
            throw new TRPCError({ code: "NOT_FOUND", message: `no item ${input.id}` });
        }
        return { id: input.id, name };
    }),
    remove: t.procedure.input(withId).mutation(({ input }) => ({ removed: items.delete(input.id) }))
});

/** GETs a query procedure and prints the answer. */
function query(path, input) {
    return async () => {
        const search = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
        const response = await fetchTest(`http://localhost:${PORT}/trpc/${path}${search}`);
        console.log(await response.text());
    };
}

/** POSTs a mutation and prints the answer. */
function mutate(path, input) {
    return async () => {
        const response = await fetchTest(`http://localhost:${PORT}/trpc/${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input)
        });
        console.log(await response.text());
    };
}

const app = express();
app.use("/trpc", createExpressMiddleware({ router: appRouter }));
app.listen(PORT, async () => {
    await sequential([
        query("list"),
        query("byId", { id: 2 }),
        // a procedure that throws NOT_FOUND, which tRPC answers as 404 with its own error shape
        query("byId", { id: 99 }),
        // input the validator refuses: 400, and the message is the one thrown above
        query("byId", { id: "two" }),
        // no such procedure
        query("nope"),
        mutate("remove", { id: 1 }),
        query("list"),
        // a mutation asked for over GET, which the adapter refuses with 405
        query("remove", { id: 2 })
    ]);
    process.exit(0);
});
