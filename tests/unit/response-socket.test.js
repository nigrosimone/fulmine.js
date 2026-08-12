// req.socket and res.socket: the small node surface a response carries, and the paths around it
// that only run when something goes wrong.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("../../src/index.js");

/**
 * @param {(app: any) => void} setup
 * @param {string} path
 * @returns {Promise<{status: number|undefined, body: string, error: string|undefined}>}
 */
async function ask(setup, path) {
    const app = express();
    app.set("etag", false);
    setup(app);
    const server = app.listen(0);
    const port = app.address().port;
    try {
        return await new Promise((resolve) => {
            const req = http.request(`http://127.0.0.1:${port}${path}`, (res) => {
                /** @type {Buffer[]} */
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () =>
                    resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), error: undefined })
                );
                res.on("error", (err) => resolve({ status: res.statusCode, body: "", error: err.message }));
            });
            req.on("error", (err) => resolve({ status: undefined, body: "", error: err.message }));
            req.end();
        });
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
}

test("the socket reports the address and the ports", async () => {
    const answer = await ask((app) => {
        app.get("/where", (req, res) => {
            res.json({
                remote: typeof req.socket.remoteAddress,
                remotePort: typeof req.socket.remotePort,
                localPort: typeof req.socket.localPort,
                encrypted: req.socket.encrypted === true,
                same: req.socket === req.connection
            });
        });
    }, "/where");
    assert.deepStrictEqual(JSON.parse(answer.body), {
        remote: "string",
        remotePort: "number",
        localPort: "number",
        encrypted: false,
        same: true
    });
});

test("closing the socket ends the answer without finishing it", async () => {
    const answer = await ask((app) => {
        app.get("/cut", (req, res) => {
            res.socket.close();
        });
    }, "/cut");
    assert.strictEqual(answer.status, undefined, "nothing was answered");
    assert.ok(answer.error, "the client sees the connection go");
});

test("closing it twice is not an error, and a finished response ignores it", async () => {
    const answer = await ask((app) => {
        app.get("/late", (req, res) => {
            res.send("done");
            // the answer has gone; closing the socket now must not throw over it
            res.socket.close();
            res.socket.close();
        });
    }, "/late");
    assert.strictEqual(answer.status, 200);
    assert.strictEqual(answer.body, "done");
});

test("end() on the socket ends the response, as node's does", async () => {
    const answer = await ask((app) => {
        app.get("/socket-end", (req, res) => {
            res.type("text/plain");
            res.socket.end("through the socket");
        });
    }, "/socket-end");
    assert.strictEqual(answer.status, 200);
    assert.strictEqual(answer.body, "through the socket");
});

test("writing after the response is finished destroys rather than answers twice", async () => {
    /** @type {any[]} */
    const errors = [];
    const answer = await ask((app) => {
        app.get("/after", (req, res) => {
            res.on("error", (err) => errors.push(err));
            res.send("first");
            res.write("second");
        });
    }, "/after");
    assert.strictEqual(answer.body, "first");
    assert.ok(
        errors.some((err) => /already finished/i.test(err.message)),
        "the write after the end is reported to the response"
    );
});
