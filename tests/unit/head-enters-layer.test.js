// A HEAD enters a route whose path matched even when its verb cannot serve one.
//
// Express exempts HEAD from the method check ("if (!hasMethod && method !== 'HEAD')" in
// router/index.js), so the layer is entered, its parameters are captured and its param() callbacks
// run, and only then does the route itself decline. Skipping such a route outright meant a callback
// with an effect never ran under HEAD while it ran under the verb the route is written for.
//
// A unit test rather than a comparison one: what has to be pinned is whether the callback ran, and
// a route that declines drops the header it set, so nothing the client receives says so.

const test = require("node:test");
const assert = require("node:assert");

const express = require("../../src/index.js");

/**
 * An app whose only route is a DELETE, with a param callback that records what it ran for.
 *
 * @returns {Promise<{url: string, close: () => void, ran: string[]}>}
 */
function serve() {
    return new Promise((resolve) => {
        /** @type {string[]} */
        const ran = [];
        const app = express();
        app.set("etag", false);
        const router = express.Router();
        router.param("p", (req, res, next, value) => {
            ran.push(String(value));
            next();
        });
        // no GET and no HEAD, so nothing here can answer a HEAD
        router.delete("/only-delete/:p", (req, res) => res.json({ r: "delete" }));
        app.use("/at", router);
        app.use((req, res) => res.status(404).send("no route"));
        app.listen(0, () => {
            resolve({ url: `http://localhost:${app.address().port}`, close: () => app.close(), ran });
        });
    });
}

test("a HEAD runs the param callbacks of a route whose verb cannot answer it", async () => {
    const { url, close, ran } = await serve();

    const res = await fetch(`${url}/at/only-delete/VAL`, { method: "HEAD" });
    // the route still declines: nothing in that router serves a HEAD
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(ran, ["VAL"], "the layer is entered for its parameters before it declines");

    close();
});

test("the verb the route is written for reaches it as it always did", async () => {
    const { url, close, ran } = await serve();

    const res = await fetch(`${url}/at/only-delete/VAL`, { method: "DELETE" });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(ran, ["VAL"]);

    close();
});

test("a GET does not enter it, since only HEAD is exempt from the method check", async () => {
    const { url, close, ran } = await serve();

    const res = await fetch(`${url}/at/only-delete/VAL`);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(ran, [], "a GET is not exempt, so the layer is never entered");

    close();
});

test("a HEAD that matches nothing has no layer to enter", async () => {
    const { url, close, ran } = await serve();

    const res = await fetch(`${url}/at/absent/VAL`, { method: "HEAD" });
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(ran, []);

    close();
});
