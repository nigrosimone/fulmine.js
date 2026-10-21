// res.type() keeps the Content-Type it stored per argument and skips set() and setHeader() the next
// time. The skip must not hide the response from a library that replaced either one, and must
// still refuse once the head is out.

const test = require("node:test");
const assert = require("node:assert");

const express = require("../../src/index.js");

/**
 * @param {(app: any) => void} setup
 * @returns {Promise<{url: string, close: () => void}>}
 */
function serve(setup) {
    return new Promise((resolve) => {
        const app = express();
        app.set("etag", false);
        setup(app);
        app.listen(0, () => {
            resolve({ url: `http://localhost:${app.address().port}`, close: () => app.close() });
        });
    });
}

test("a setHeader replaced on the response still sees every res.type()", async () => {
    /** @type {string[]} */
    const seen = [];
    const { url, close } = await serve((app) => {
        app.get("/plain", (req, res) => {
            // a body from the request, so the route is not compiled and type() really runs
            res.type("text/plain").send(req.path);
        });
        app.get("/watched", (req, res) => {
            const setHeader = res.setHeader;
            res.setHeader = function (name, value) {
                seen.push(`${name}: ${value}`);
                return setHeader.call(this, name, value);
            };
            // end(), not send(): send sets the Content-Type again and would fill seen by itself
            res.type("text/plain").end("watched");
        });
    });
    try {
        // the first fills the cache, the rest would take the skip
        for (let i = 0; i < 3; i++) {
            const res = await fetch(`${url}/plain`);
            assert.strictEqual(res.headers.get("content-type"), "text/plain; charset=utf-8");
            await res.text();
        }
        for (let i = 0; i < 2; i++) {
            const res = await fetch(`${url}/watched`);
            assert.strictEqual(res.headers.get("content-type"), "text/plain; charset=utf-8");
            await res.text();
        }
        assert.deepStrictEqual(seen, [
            "Content-Type: text/plain; charset=utf-8",
            "Content-Type: text/plain; charset=utf-8"
        ]);
    } finally {
        close();
    }
});

test("res.type() after the head is out throws as setHeader does, cached or not", async () => {
    /** @type {string[]} */
    const errors = [];
    const { url, close } = await serve((app) => {
        app.get("/late", (req, res) => {
            res.type("json").send("{}");
            try {
                res.type("json");
            } catch (err) {
                errors.push(/** @type {any} */ (err).code);
            }
        });
    });
    try {
        for (let i = 0; i < 2; i++) {
            await (await fetch(`${url}/late`)).text();
        }
        assert.deepStrictEqual(errors, ["ERR_HTTP_HEADERS_SENT", "ERR_HTTP_HEADERS_SENT"]);
    } finally {
        close();
    }
});
