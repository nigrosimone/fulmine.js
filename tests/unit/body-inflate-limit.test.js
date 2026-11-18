// No call to the decompressor gives back more than the limit and one byte: a bomb is a 413 before
// the allocation, not after (decompression-bomb in the HttpArena resilience suite).

const test = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");

const fastZlib = require("fast-zlib");
const express = require("../../src/index.js");

function serve(setup) {
    return new Promise((resolve) => {
        const app = express();
        setup(app);
        app.listen(0, () => {
            resolve({ port: app.address().port, close: () => app.close() });
        });
    });
}

/**
 * The largest buffer any decompressor's process() returned while `run` was going.
 *
 * @param {() => Promise<void>} run
 * @returns {Promise<number>}
 */
async function largestInflatedChunk(run) {
    const proto = Object.getPrototypeOf(fastZlib.Gunzip.prototype);
    const original = proto.process;
    let largest = 0;
    proto.process = function (...args) {
        const out = original.apply(this, args);
        if (out && out.length > largest) largest = out.length;
        return out;
    };
    try {
        await run();
    } finally {
        proto.process = original;
    }
    return largest;
}

for (const [encoding, compress] of [
    ["gzip", zlib.gzipSync],
    ["deflate", zlib.deflateSync],
    ["br", zlib.brotliCompressSync]
]) {
    test(`a ${encoding} bomb is refused at the limit, never inflated past it`, async () => {
        const limit = 100 * 1024;
        const { port, close } = await serve((app) => {
            app.post("/", express.raw({ type: () => true }), (req, res) => res.send("read " + req.body.length));
            app.use((err, req, res, next) => res.status(err.status || 500).send(err.type || "error"));
        });
        try {
            // 64 MB of zeros compresses to a single chunk's worth of bytes
            const bomb = compress(Buffer.alloc(64 * 1024 * 1024));
            let answer;
            const largest = await largestInflatedChunk(async () => {
                const res = await fetch(`http://127.0.0.1:${port}/`, {
                    method: "POST",
                    headers: { "content-encoding": encoding, "content-type": "application/octet-stream" },
                    body: bomb
                });
                answer = { status: res.status, body: await res.text() };
            });
            assert.deepStrictEqual(answer, { status: 413, body: "entity.too.large" });
            assert.ok(largest <= limit + 1, `one call inflated ${largest} bytes, the limit is ${limit}`);
        } finally {
            close();
        }
    });
}

test("a compressed body under the limit is still inflated whole", async () => {
    const { port, close } = await serve((app) => {
        app.post("/", express.raw({ type: () => true }), (req, res) => res.send("read " + req.body.length));
    });
    try {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
            method: "POST",
            headers: { "content-encoding": "gzip", "content-type": "application/octet-stream" },
            body: zlib.gzipSync(Buffer.alloc(100 * 1024, "a"))
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await res.text(), "read " + 100 * 1024);
    } finally {
        close();
    }
});
