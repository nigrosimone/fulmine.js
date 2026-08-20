// express.compression() answering zstd, which the compression module cannot do at all, so there
// is no arm to compare against and this lives here rather than under tests/tests.
//
// The rule the ranking has to keep: a client that takes brotli as well is answered exactly as it
// was before zstd existed. Everything else is about the two ways a body reaches the wire, whole
// from send() and in pieces from a pipe, since those are separate paths through the middleware.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const zlib = require("zlib");
const { Readable } = require("stream");
const express = require("../../src/index.js");

const HAS_ZSTD = typeof zlib.zstdCompressSync === "function";
const BIG = "Hello World".repeat(500);

// structured but not repetitive, so one compression level can be told from another
const VARIED = Array.from(
    { length: 4000 },
    (row, index) =>
        `row ${index} ${((index * 2654435761) % 100000).toString(36)} ${"abcdefghijklmnopqrstuvwxyz".slice(index % 20)}`
).join("\n");

/**
 * @param {(app: any) => void} setup
 * @param {string} path
 * @param {string} accept what to send as Accept-Encoding
 * @returns {Promise<{status: number, encoding: string|null, length: string|null, body: Buffer}>}
 */
async function ask(setup, path, accept) {
    const app = express();
    app.set("etag", false);
    setup(app);
    const server = app.listen(0);
    try {
        return await raw(app.address().port, path, accept);
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
}

/**
 * One request, with the body as it left the server. node's own client is what this is for: fetch
 * decodes gzip, brotli and zstd on the way in, so the bytes under test would never be seen.
 *
 * @param {number} port
 * @param {string} path
 * @param {string} accept what to send as Accept-Encoding, "" to send none at all
 * @returns {Promise<{status: number, encoding: string|null, length: string|null, body: Buffer}>}
 */
function raw(port, path, accept) {
    return new Promise((resolve, reject) => {
        const request = http.get(
            { host: "127.0.0.1", port, path, headers: accept ? { "accept-encoding": accept } : {} },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        encoding: res.headers["content-encoding"] ?? null,
                        length: res.headers["content-length"] ?? null,
                        body: Buffer.concat(chunks)
                    })
                );
            }
        );
        request.on("error", reject);
    });
}

/** @param {any} app */
function routes(app) {
    app.use(express.compression({ threshold: 1024 }));
    app.get("/whole", (req, res) => res.type("text/plain").send(BIG));
    app.get("/pieces", (req, res) => {
        res.type("text/plain");
        Readable.from([BIG.slice(0, 2000), BIG.slice(2000)]).pipe(res);
    });
    app.get("/small", (req, res) => res.type("text/plain").send("small"));
}

test("a client that asks for zstd is answered in zstd", { skip: !HAS_ZSTD }, async () => {
    const answer = await ask(routes, "/whole", "zstd");
    assert.strictEqual(answer.encoding, "zstd");
    assert.strictEqual(zlib.zstdDecompressSync(answer.body).toString(), BIG);
});

test("a whole body keeps its Content-Length", { skip: !HAS_ZSTD }, async () => {
    const answer = await ask(routes, "/whole", "zstd");
    assert.strictEqual(answer.length, String(answer.body.length));
});

test("a body that arrives in pieces is streamed through zstd", { skip: !HAS_ZSTD }, async () => {
    const answer = await ask(routes, "/pieces", "zstd");
    assert.strictEqual(answer.encoding, "zstd");
    assert.strictEqual(zlib.zstdDecompressSync(answer.body).toString(), BIG);
});

test("below the threshold zstd is not used either", { skip: !HAS_ZSTD }, async () => {
    const answer = await ask(routes, "/small", "zstd");
    assert.strictEqual(answer.encoding, null);
    assert.strictEqual(answer.body.toString(), "small");
});

test("a browser's list still gets brotli, as it did before zstd", { skip: !HAS_ZSTD }, async () => {
    const answer = await ask(routes, "/whole", "gzip, deflate, br, zstd");
    assert.strictEqual(answer.encoding, "br");
});

test("zstd wins over gzip when brotli is not on the list", { skip: !HAS_ZSTD }, async () => {
    const answer = await ask(routes, "/whole", "gzip, deflate, zstd");
    assert.strictEqual(answer.encoding, "zstd");
});

test("a higher q takes zstd over brotli", { skip: !HAS_ZSTD }, async () => {
    const answer = await ask(routes, "/whole", "br;q=0.5, zstd;q=1");
    assert.strictEqual(answer.encoding, "zstd");
});

test("zstd refused with q=0 is not sent", { skip: !HAS_ZSTD }, async () => {
    const answer = await ask(routes, "/whole", "zstd;q=0");
    assert.strictEqual(answer.encoding, null);
});

test("encodings can put zstd in front of brotli", { skip: !HAS_ZSTD }, async () => {
    const answer = await ask(
        (app) => {
            app.use(express.compression({ threshold: 1024, encodings: ["zstd", "gzip"] }));
            app.get("/whole", (req, res) => res.type("text/plain").send(BIG));
        },
        "/whole",
        "gzip, deflate, br, zstd"
    );
    assert.strictEqual(answer.encoding, "zstd");
    assert.strictEqual(zlib.zstdDecompressSync(answer.body).toString(), BIG);
});

test("a level given under zstd reaches zlib", { skip: !HAS_ZSTD }, async () => {
    /**
     * @param {number} level
     * @returns {Promise<number>} how many bytes the body left as
     */
    const at = async (level) => {
        const answer = await ask(
            (app) => {
                app.use(
                    express.compression({
                        threshold: 1024,
                        zstd: { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } }
                    })
                );
                app.get("/varied", (req, res) => res.type("text/plain").send(VARIED));
            },
            "/varied",
            "zstd"
        );
        assert.strictEqual(answer.encoding, "zstd");
        assert.strictEqual(zlib.zstdDecompressSync(answer.body).toString(), VARIED);
        return answer.body.length;
    };
    // BIG would not do here: "Hello World" over and over is 29 bytes at every level there is, so
    // the option could be dropped on the floor and the sizes would still match
    const [low, high] = [await at(1), await at(19)];
    assert.ok(high < low, `level 19 should beat level 1: ${high} against ${low}`);
});

test("enforceEncoding may name zstd", { skip: !HAS_ZSTD }, async () => {
    const app = express();
    app.set("etag", false);
    app.use(express.compression({ threshold: 1024, enforceEncoding: "zstd" }));
    app.get("/whole", (req, res) => res.type("text/plain").send(BIG));
    const server = app.listen(0);
    try {
        // no Accept-Encoding at all, which is the only case enforceEncoding speaks for
        const answer = await raw(app.address().port, "/whole", "");
        assert.strictEqual(answer.encoding, "zstd");
        assert.strictEqual(zlib.zstdDecompressSync(answer.body).toString(), BIG);
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
});

test("naming an encoding nobody knows still throws", () => {
    assert.throws(() => express.compression({ encodings: ["zstandard"] }), /unknown encoding/);
});
