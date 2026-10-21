// The whole-body gzip and deflate paths keep one zlib stream and reset it between responses
// instead of building a new one per call. That is only allowed to be faster: the bytes have to
// stay the ones zlib.gzipSync would have written, on every response and not just the first, since
// a stream that kept state answers the second body with bytes that depend on the first.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const zlib = require("node:zlib");
const express = require("../../src/index.js");

const BODIES = [
    Buffer.from(JSON.stringify({ items: [], count: 0 })),
    Buffer.from(JSON.stringify({ items: Array.from({ length: 40 }, (item, i) => ({ id: i, name: `item-${i}` })) })),
    Buffer.alloc(2048, 0x7a),
    Buffer.from("{}".repeat(3000))
];

/**
 * @param {any} options
 * @param {string} encoding
 * @returns {Promise<Buffer[]>} one answer per body, in order, over several passes
 */
async function askAll(options, encoding) {
    const app = express();
    app.set("etag", false);
    app.get("/b/:i", express.compression({ ...options, encodings: [encoding], threshold: 0 }), (req, res) => {
        res.type("application/json").send(BODIES[Number(req.params.i)]);
    });
    const server = app.listen(0);
    const port = app.address().port;
    /** @type {Buffer[]} */
    const out = [];
    try {
        // three passes over the same bodies: the first fills the stream, the rest are the ones
        // that catch a reset that did not reset
        for (let pass = 0; pass < 3; pass++) {
            for (let i = 0; i < BODIES.length; i++) {
                out.push(
                    await new Promise((resolve, reject) => {
                        http.get({ port, path: `/b/${i}`, headers: { "accept-encoding": encoding } }, (res) => {
                            assert.strictEqual(res.headers["content-encoding"], encoding);
                            /** @type {Buffer[]} */
                            const chunks = [];
                            res.on("data", (chunk) => chunks.push(chunk));
                            res.on("end", () => resolve(Buffer.concat(chunks)));
                        }).on("error", reject);
                    })
                );
            }
        }
    } finally {
        server.close();
    }
    return out;
}

test("gzip answers the bytes gzipSync would, on every response", async () => {
    for (const options of [{ level: 1 }, { level: 3 }, {}, { level: 9, memLevel: 6 }]) {
        const answers = await askAll(options, "gzip");
        answers.forEach((answer, n) => {
            const body = BODIES[n % BODIES.length];
            assert.deepStrictEqual(
                answer,
                zlib.gzipSync(body, options),
                `gzip ${JSON.stringify(options)} differs on response ${n}`
            );
            assert.deepStrictEqual(zlib.gunzipSync(answer), body);
        });
    }
});

test("deflate answers the bytes deflateSync would, on every response", async () => {
    const answers = await askAll({ level: 1 }, "deflate");
    answers.forEach((answer, n) => {
        const body = BODIES[n % BODIES.length];
        assert.deepStrictEqual(answer, zlib.deflateSync(body, { level: 1 }));
        assert.deepStrictEqual(zlib.inflateSync(answer), body);
    });
});

test("the kept stream is the one answering, not zlib.gzipSync per response", async () => {
    // The guard falls back to the one-shot call whenever the kept stream would answer differently,
    // so the byte tests above stay green even when the fast path never runs. This is the one that
    // notices: on a single server gzipSync is called by the startup probe and then never again.
    const real = zlib.gzipSync;
    let calls = 0;
    zlib.gzipSync = (...args) => {
        calls++;
        return real(...args);
    };
    const app = express();
    app.set("etag", false);
    app.get("/b", express.compression({ level: 1, encodings: ["gzip"], threshold: 0 }), (req, res) => {
        res.type("application/json").send(BODIES[1]);
    });
    const server = app.listen(0);
    const port = app.address().port;
    const ask = () =>
        new Promise((resolve, reject) => {
            http.get({ port, path: "/b", headers: { "accept-encoding": "gzip" } }, (res) => {
                res.on("data", () => {});
                res.on("end", resolve);
            }).on("error", reject);
        });
    try {
        await ask();
        const afterFirst = calls;
        for (let i = 0; i < 11; i++) {
            await ask();
        }
        assert.strictEqual(
            calls,
            afterFirst,
            `gzipSync ran ${calls - afterFirst} more times over 11 responses, so they are not ` +
                "coming from the kept stream"
        );
    } finally {
        zlib.gzipSync = real;
        server.close();
    }
});

test("brotli answers the bytes brotliCompressSync would, on every response", async () => {
    for (const quality of [undefined, 1, 3, 11]) {
        const params = quality === undefined ? {} : { [zlib.constants.BROTLI_PARAM_QUALITY]: quality };
        const answers = await askAll({ brotli: { params } }, "br");
        // the middleware's default quality is 4, as the compression module's
        const expected = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, ...params } };
        answers.forEach((answer, n) => {
            const body = BODIES[n % BODIES.length];
            assert.deepStrictEqual(
                answer,
                zlib.brotliCompressSync(body, expected),
                `br quality ${quality} differs on response ${n}`
            );
            assert.deepStrictEqual(zlib.brotliDecompressSync(answer), body);
        });
    }
});

// whether this node's brotli handle forgets the last body on reset, which it does from 26.11
function brotliResets() {
    const params = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } };
    const stream = /** @type {any} */ (zlib.createBrotliCompress(params));
    const out = Buffer.allocUnsafe(4096);
    const body = Buffer.from("{}".repeat(600));
    let same = 0;
    for (let i = 0; i < 2; i++) {
        stream._handle.writeSync(zlib.constants.BROTLI_OPERATION_FINISH, body, 0, body.length, out, 0, 4096);
        same += out.subarray(0, 4096 - stream._writeState[0]).equals(zlib.brotliCompressSync(body, params)) ? 1 : 0;
        stream._handle.reset();
    }
    stream.destroy();
    return same === 2;
}

test(
    "the kept brotli handle is the one answering, not zlib.brotliCompressSync per response",
    {
        skip: brotliResets() ? false : "this node keeps the brotli context on reset, the one-shot call answers"
    },
    async () => {
        const real = zlib.brotliCompressSync;
        let calls = 0;
        zlib.brotliCompressSync = (...args) => {
            calls++;
            return real(...args);
        };
        const app = express();
        app.set("etag", false);
        app.get("/b", express.compression({ encodings: ["br"], threshold: 0 }), (req, res) => {
            res.type("application/json").send(BODIES[1]);
        });
        const server = app.listen(0);
        const port = app.address().port;
        const ask = () =>
            new Promise((resolve, reject) => {
                http.get({ port, path: "/b", headers: { "accept-encoding": "br" } }, (res) => {
                    res.on("data", () => {});
                    res.on("end", resolve);
                }).on("error", reject);
            });
        try {
            await ask();
            const afterFirst = calls;
            for (let i = 0; i < 11; i++) {
                await ask();
            }
            assert.strictEqual(
                calls,
                afterFirst,
                `brotliCompressSync ran ${calls - afterFirst} more times over 11 responses`
            );
        } finally {
            zlib.brotliCompressSync = real;
            server.close();
        }
    }
);

test("a body compressed whole keeps the headers object fast, its Content-Length is overwritten", async () => {
    const v8 = require("node:v8");
    v8.setFlagsFromString("--allow-natives-syntax");
    const hasFastProperties = new Function("o", "return %HasFastProperties(o)");
    v8.setFlagsFromString("--no-allow-natives-syntax");
    /** @type {boolean[]} */
    const fast = [];
    const app = express();
    app.get("/j", express.compression({ encodings: ["gzip"] }), (req, res) => {
        res.json({ items: Array.from({ length: 60 }, (item, i) => ({ id: i, name: `item-${i}` })) });
        // a delete on the headers object turns it to dictionary mode, which every compressed
        // response paid for in writeHeaders and in GC
        fast.push(hasFastProperties(res.headers));
    });
    const server = app.listen(0);
    try {
        const { headers, body } = await new Promise((resolve, reject) => {
            http.get({ port: app.address().port, path: "/j", headers: { "accept-encoding": "gzip" } }, (res) => {
                /** @type {Buffer[]} */
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
            }).on("error", reject);
        });
        assert.strictEqual(headers["content-encoding"], "gzip");
        assert.strictEqual(Number(headers["content-length"]), body.length);
        assert.strictEqual(JSON.parse(zlib.gunzipSync(body).toString()).items.length, 60);
        assert.deepStrictEqual(fast, [true]);
    } finally {
        server.close();
    }
});
