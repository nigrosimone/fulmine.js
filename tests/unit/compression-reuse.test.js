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
    // @ts-expect-error a counting wrapper around the real one
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

test("brotli is left on the one-shot call, whose stream cannot be reset", async () => {
    const answers = await askAll({}, "br");
    answers.forEach((answer, n) => {
        const body = BODIES[n % BODIES.length];
        assert.deepStrictEqual(zlib.brotliDecompressSync(answer), body);
    });
});
