// The call shapes express.compression() has to survive, which the compression module's own suite
// does not cover because they are node's rather than the middleware's: end() with a callback, end()
// twice, and a drain listener registered before there is a compressor to hang it on.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const zlib = require("node:zlib");
const express = require("../../src/index.js");

/**
 * @param {(app: any) => void} setup
 * @param {string} path
 * @returns {Promise<{status: number, encoding: string|undefined, body: string}>}
 */
async function ask(setup, path) {
    const app = express();
    app.set("etag", false);
    setup(app);
    const server = app.listen(0);
    const port = app.address().port;
    try {
        return await new Promise((resolve, reject) => {
            const req = http.request(
                `http://127.0.0.1:${port}${path}`,
                { headers: { "accept-encoding": "gzip" } },
                (res) => {
                    /** @type {Buffer[]} */
                    const chunks = [];
                    res.on("data", (chunk) => chunks.push(chunk));
                    res.on("end", () => {
                        const raw = Buffer.concat(chunks);
                        const encoding = res.headers["content-encoding"];
                        resolve({
                            status: /** @type {number} */ (res.statusCode),
                            encoding,
                            body: (encoding === "gzip" ? zlib.gunzipSync(raw) : raw).toString()
                        });
                    });
                }
            );
            req.on("error", reject);
            req.end();
        });
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
}

test("end(chunk, callback) calls back once the answer has gone", async () => {
    let called = false;
    const answer = await ask((app) => {
        app.use(express.compression({ threshold: 0 }));
        app.get("/cb", (req, res) => {
            res.type("text/plain");
            res.end("hello, world", () => {
                called = true;
            });
        });
    }, "/cb");
    assert.strictEqual(answer.encoding, "gzip");
    assert.strictEqual(answer.body, "hello, world");
    assert.ok(called, "the callback ran");
});

test("end(callback) with no body at all", async () => {
    let called = false;
    const answer = await ask((app) => {
        app.use(express.compression({ threshold: 0 }));
        app.get("/empty", (req, res) => {
            res.type("text/plain");
            res.end(() => {
                called = true;
            });
        });
    }, "/empty");
    assert.strictEqual(answer.body, "");
    assert.ok(called, "the callback ran");
});

test("a second end() is ignored, compressed or not", async () => {
    const answer = await ask((app) => {
        app.use(express.compression({ threshold: 0 }));
        app.get("/twice", (req, res) => {
            res.type("text/plain");
            res.end("first");
            res.end("second");
            res.write("third");
        });
    }, "/twice");
    assert.strictEqual(answer.body, "first");
});

test("a drain listener registered before the first write reaches the compressor", async () => {
    const answer = await ask((app) => {
        app.use(express.compression({ threshold: 0 }));
        app.get("/drain", (req, res) => {
            // parked: there is no compressor yet, and this is what a pipe does the moment write()
            // asks it to slow down
            res.on("drain", () => {});
            res.type("text/plain");
            res.write("a".repeat(2048));
            res.end("b");
        });
    }, "/drain");
    assert.strictEqual(answer.body, "a".repeat(2048) + "b");
    assert.strictEqual(answer.encoding, "gzip");
});

test("a listener for anything else still goes on the response", async () => {
    let closed = false;
    const answer = await ask((app) => {
        app.use(express.compression({ threshold: 0 }));
        app.get("/close", (req, res) => {
            res.on("close", () => {
                closed = true;
            });
            res.type("text/plain").send("done");
        });
    }, "/close");
    assert.strictEqual(answer.body, "done");
    assert.ok(closed, "'close' was not swallowed by the drain parking");
});

test("a body over the sync limit is compressed on the pool and comes back whole", async () => {
    const big = "x".repeat(64 * 1024);
    const answer = await ask((app) => {
        app.use(express.compression({ threshold: 0 }));
        app.get("/big", (req, res) => res.type("text/plain").send(big));
    }, "/big");
    assert.strictEqual(answer.encoding, "gzip");
    assert.strictEqual(answer.body, big);
});
