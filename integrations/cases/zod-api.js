// express-zod-api through attachRouting(): its endpoints on the arm's own app, with input that
// passes and input that fails validation, thrown http errors, CORS and the 404 it answers.
//
// Each error goes through its result handler, which calls res.set(error.headers) with undefined: it
// answered 500 on every error before 5.33.3. The package is ESM only, so it is imported.

const { express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13822;

/** Sends one request and prints the status, the content type and the body. */
function request(method, path, body) {
    return async () => {
        const init = { method, headers: {} };
        if (body !== undefined) {
            init.body = typeof body === "string" ? body : JSON.stringify(body);
            init.headers["content-type"] = "application/json";
        }
        const response = await fetchTest(`http://localhost:${PORT}${path}`, init);
        const cors = response.headers.get("access-control-allow-methods");
        console.log(method, path, response.status, response.headers.get("content-type"), cors, await response.text());
    };
}

(async () => {
    const { createConfig, attachRouting, defaultEndpointsFactory, ez } = await import("express-zod-api");
    const { z } = await import("zod");
    const createHttpError = require("http-errors");

    const hello = defaultEndpointsFactory.build({
        input: z.object({ name: z.string().optional() }),
        output: z.object({ greetings: z.string() }),
        handler: async ({ input: { name } }) => ({ greetings: `Hello, ${name || "World"}` })
    });
    const retrieve = defaultEndpointsFactory.build({
        input: z.object({ id: z.string().regex(/^\d+$/).transform(Number) }),
        output: z.object({ id: z.number(), name: z.string() }),
        handler: async ({ input: { id } }) => {
            if (id > 100) throw createHttpError(404, "User not found");
            return { id, name: "John Doe" };
        }
    });
    const update = defaultEndpointsFactory.build({
        method: "patch",
        input: z.object({ id: z.string(), key: z.string().min(1), name: z.string().min(1), birthday: ez.dateIn() }),
        output: z.object({ id: z.string(), name: z.string(), createdAt: ez.dateOut() }),
        handler: async ({ input: { id, name, key } }) => {
            if (key !== "123") throw createHttpError(401, "Invalid key");
            return { id, name, createdAt: new Date("2022-01-22T00:00:00Z") };
        }
    });
    const boom = defaultEndpointsFactory.build({
        output: z.object({}),
        handler: async () => {
            throw new Error("internal");
        }
    });

    const app = express();
    app.use(express.json());
    const config = createConfig({ app, cors: true, startupLogo: false, logger: { level: "silent" } });
    const { notFoundHandler } = attachRouting(config, { v1: { hello, user: { retrieve, ":id": update }, boom } });
    app.use(notFoundHandler);
    // the 405 it passes on: the message, as the final handler would log a stack whose frames differ
    app.use((err, req, res, next) => res.status(err.status || 500).send(err.message));

    app.listen(PORT, async () => {
        await sequential([
            request("GET", "/v1/hello"),
            request("GET", "/v1/hello?name=fulmine"),
            request("GET", "/v1/user/retrieve?id=10"),
            // the errors, each through the result handler
            request("GET", "/v1/user/retrieve?id=101"),
            request("GET", "/v1/user/retrieve?id=abc"),
            request("GET", "/v1/user/retrieve"),
            request("PATCH", "/v1/user/10", { key: "123", name: "John", birthday: "1963-04-21" }),
            request("PATCH", "/v1/user/10", { key: "456", name: "John", birthday: "1963-04-21" }),
            request("PATCH", "/v1/user/10", { key: "123", name: "", birthday: "nope" }),
            request("PATCH", "/v1/user/10", "{bad json"),
            request("GET", "/v1/boom"),
            // CORS preflight, a method the route does not take, and no route at all
            request("OPTIONS", "/v1/hello"),
            request("POST", "/v1/hello", { name: "post" }),
            request("GET", "/nope")
        ]);
        process.exit(0);
    });
})();
