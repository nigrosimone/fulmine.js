// express.static({ preCompressed: true }): serving file.br or file.gz in place of file.
//
// Express has nothing to compare against here, which is why this is a unit test and not one of the
// differential ones. What it pins is the part that is easy to get subtly wrong: the answer depends
// on Accept-Encoding, so Vary has to be there whatever is served, the content type has to come from
// the name that was asked for rather than from the .br that is being sent, and the ETag has to be
// the variant's own. Two bodies behind one ETag is how a shared cache hands brotli to a client that
// asked for gzip.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const express = require("../../src/index.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-precompressed-"));

const SCRIPT = 'console.log("hello");'.repeat(200);
const STYLE = "body{color:red}".repeat(200);
const INDEX = "<h1>index</h1>".repeat(50);
const PLAIN = "nothing precompressed here";

// app.js has both variants, site.css only gzip, plain.txt neither
fs.writeFileSync(path.join(root, "app.js"), SCRIPT);
fs.writeFileSync(path.join(root, "app.js.br"), zlib.brotliCompressSync(Buffer.from(SCRIPT)));
fs.writeFileSync(path.join(root, "app.js.gz"), zlib.gzipSync(Buffer.from(SCRIPT)));
fs.writeFileSync(path.join(root, "site.css"), STYLE);
fs.writeFileSync(path.join(root, "site.css.gz"), zlib.gzipSync(Buffer.from(STYLE)));
fs.writeFileSync(path.join(root, "plain.txt"), PLAIN);
fs.writeFileSync(path.join(root, "index.html"), INDEX);
fs.writeFileSync(path.join(root, "index.html.br"), zlib.brotliCompressSync(Buffer.from(INDEX)));

const app = express();
app.use(express.static(root, { preCompressed: true }));
const server = app.listen(0);
const port = () => app.address().port;

test.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
});

/**
 * @param {string} target
 * @param {object} [options]
 * @param {string} [options.accept] Accept-Encoding, left off entirely when absent
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @returns {Promise<{status: number, headers: any, raw: Buffer, text: string}>}
 */
function request(target, options = {}) {
    const headers = { ...options.headers };
    if (options.accept !== undefined) {
        headers["accept-encoding"] = options.accept;
    }
    return new Promise((resolve, reject) => {
        const req = http.request(
            `http://127.0.0.1:${port()}${target}`,
            { method: options.method || "GET", headers },
            (res) => {
                /** @type {Buffer[]} */
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks);
                    const encoding = res.headers["content-encoding"];
                    const decoded =
                        raw.length === 0
                            ? raw
                            : encoding === "br"
                              ? zlib.brotliDecompressSync(raw)
                              : encoding === "gzip"
                                ? zlib.gunzipSync(raw)
                                : raw;
                    resolve({
                        status: /** @type {number} */ (res.statusCode),
                        headers: res.headers,
                        raw,
                        text: decoded.toString()
                    });
                });
            }
        );
        req.on("error", reject);
        req.end();
    });
}

test("brotli is served when both variants are there and both are accepted", async () => {
    const res = await request("/app.js", { accept: "br, gzip" });
    assert.strictEqual(res.headers["content-encoding"], "br");
    assert.strictEqual(res.headers.vary, "Accept-Encoding");
    assert.strictEqual(res.text, SCRIPT);
    // the type of the file that was asked for, not of the one that was sent
    assert.match(res.headers["content-type"], /^text\/javascript/);
    // and the body on the wire really is the smaller one
    assert.ok(res.raw.length < SCRIPT.length);
});

test("gzip is served when that is all the client takes", async () => {
    const res = await request("/app.js", { accept: "gzip" });
    assert.strictEqual(res.headers["content-encoding"], "gzip");
    assert.strictEqual(res.text, SCRIPT);
});

test("the client's q values decide between them", async () => {
    const res = await request("/app.js", { accept: "br;q=0.2, gzip;q=0.9" });
    assert.strictEqual(res.headers["content-encoding"], "gzip");
});

test("a refused encoding is not sent", async () => {
    const res = await request("/app.js", { accept: "br;q=0, gzip;q=0" });
    assert.strictEqual(res.headers["content-encoding"], undefined);
    assert.strictEqual(res.text, SCRIPT);
});

test("no Accept-Encoding at all means the file itself", async () => {
    const res = await request("/app.js");
    assert.strictEqual(res.headers["content-encoding"], undefined);
    assert.strictEqual(res.headers.vary, "Accept-Encoding");
    assert.strictEqual(res.text, SCRIPT);
});

test("identity means the file itself", async () => {
    const res = await request("/app.js", { accept: "identity" });
    assert.strictEqual(res.headers["content-encoding"], undefined);
});

test("the second choice is served when the first is not on disk", async () => {
    const res = await request("/site.css", { accept: "br, gzip" });
    assert.strictEqual(res.headers["content-encoding"], "gzip");
    assert.strictEqual(res.text, STYLE);
    assert.match(res.headers["content-type"], /^text\/css/);
});

test("and nothing is served compressed when the only variant is one the client refuses", async () => {
    const res = await request("/site.css", { accept: "br" });
    assert.strictEqual(res.headers["content-encoding"], undefined);
    assert.strictEqual(res.text, STYLE);
});

test("a file nobody precompressed is served as it is, and still says Vary", async () => {
    const res = await request("/plain.txt", { accept: "br, gzip" });
    assert.strictEqual(res.headers["content-encoding"], undefined);
    assert.strictEqual(res.headers.vary, "Accept-Encoding");
    assert.strictEqual(res.text, PLAIN);
});

test("the index of a directory has variants too", async () => {
    const res = await request("/", { accept: "br" });
    assert.strictEqual(res.headers["content-encoding"], "br");
    assert.strictEqual(res.text, INDEX);
    assert.match(res.headers["content-type"], /^text\/html/);
});

test("each variant has its own ETag and Last-Modified", async () => {
    const brotli = await request("/app.js", { accept: "br" });
    const gzip = await request("/app.js", { accept: "gzip" });
    const plain = await request("/app.js", { accept: "identity" });
    const tags = new Set([brotli.headers.etag, gzip.headers.etag, plain.headers.etag]);
    assert.strictEqual(tags.size, 3, "three bodies, three ETags");
    for (const answer of [brotli, gzip, plain]) {
        assert.ok(answer.headers["last-modified"], "every answer dates the file it sent");
    }
});

test("a conditional request against a variant's ETag is answered 304", async () => {
    const first = await request("/app.js", { accept: "br" });
    const again = await request("/app.js", {
        accept: "br",
        headers: { "if-none-match": first.headers.etag }
    });
    assert.strictEqual(again.status, 304);
    assert.strictEqual(again.raw.length, 0);
});

test("HEAD answers the variant's headers and no body", async () => {
    const res = await request("/app.js", { accept: "br", method: "HEAD" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers["content-encoding"], "br");
    assert.strictEqual(res.raw.length, 0);
});

test("without the option nothing changes", async () => {
    const plainApp = express();
    plainApp.use(express.static(root));
    const plainServer = plainApp.listen(0);
    try {
        const answer = await new Promise((resolve, reject) => {
            const req = http.request(
                `http://127.0.0.1:${plainApp.address().port}/app.js`,
                { headers: { "accept-encoding": "br, gzip" } },
                (res) => {
                    /** @type {Buffer[]} */
                    const chunks = [];
                    res.on("data", (chunk) => chunks.push(chunk));
                    res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks).toString() }));
                }
            );
            req.on("error", reject);
            req.end();
        });
        assert.strictEqual(answer.headers["content-encoding"], undefined);
        assert.strictEqual(answer.headers.vary, undefined);
        assert.strictEqual(answer.body, SCRIPT);
    } finally {
        plainServer.close();
    }
});
