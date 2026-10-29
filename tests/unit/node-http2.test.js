// The app handed to node:http2, cleartext and TLS with HTTP/1.1 allowed beside it. Express itself
// crashes there, so this is not a comparison: the shim has to answer as it does over node:http.

const test = require("node:test");
const assert = require("node:assert");
const http2 = require("node:http2");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const express = require("../../src/index.js");

const tls = {
    key: fs.readFileSync(path.join(__dirname, "..", "parts", "localhost.key")),
    cert: fs.readFileSync(path.join(__dirname, "..", "parts", "localhost.crt"))
};

/** An app with the routes every test below asks for. */
function makeApp() {
    const app = express();
    app.get("/sum", (req, res) => res.send(String(Number(req.query.a) + Number(req.query.b))));
    app.get("/who", (req, res) =>
        res.json({
            host: req.get("host"),
            hostname: req.hostname,
            protocol: req.protocol,
            secure: req.secure,
            version: req.httpVersion,
            major: req.httpVersionMajor,
            pseudo: Object.keys(req.headers).filter((name) => name.startsWith(":"))
        })
    );
    app.post("/echo", express.raw({ type: () => true }), (req, res) => res.send(req.body));
    app.get("/stream", (req, res) => {
        res.type("text");
        res.write("one,");
        res.write("two,");
        res.end("three");
    });
    app.get("/closing", (req, res) => {
        res.set("Connection", "close");
        res.status(201).send("created");
    });
    app.get("/empty", (req, res) => res.status(204).end());
    app.use("/static", express.static(path.join(__dirname, "..", "parts"), { preCompressed: true }));
    return app;
}

/**
 * Listens with the given server and answers its port and a closer.
 * @param {import("node:net").Server} server
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
function listen(server) {
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = /** @type {any} */ (server.address());
            resolve({ port, close: () => new Promise((done) => server.close(() => done())) });
        });
    });
}

/**
 * One request down an HTTP/2 session.
 * @param {import("node:http2").ClientHttp2Session} session
 * @param {Record<string, string>} headers
 * @param {string|Buffer} [body]
 * @returns {Promise<{headers: import("node:http2").IncomingHttpHeaders, body: Buffer}>}
 */
function request(session, headers, body) {
    return new Promise((resolve, reject) => {
        const stream = session.request(headers);
        /** @type {Buffer[]} */
        const chunks = [];
        /** @type {import("node:http2").IncomingHttpHeaders} */
        let head = {};
        stream.on("response", (h) => (head = h));
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("end", () => resolve({ headers: head, body: Buffer.concat(chunks) }));
        stream.on("error", reject);
        stream.end(body);
    });
}

test("h2c: query, length, :authority as Host and no pseudo headers on req.headers", async () => {
    const { port, close } = await listen(http2.createServer(makeApp()));
    const session = http2.connect(`http://127.0.0.1:${port}`);
    try {
        const sum = await request(session, { ":path": "/sum?a=1&b=2" });
        assert.strictEqual(sum.headers[":status"], 200);
        assert.strictEqual(sum.body.toString(), "3");
        assert.strictEqual(sum.headers["content-length"], "1");
        assert.strictEqual(sum.headers["content-type"], "text/html; charset=utf-8");

        const who = JSON.parse((await request(session, { ":path": "/who" })).body.toString());
        assert.deepStrictEqual(who, {
            host: `127.0.0.1:${port}`,
            hostname: "127.0.0.1",
            protocol: "http",
            secure: false,
            version: "2.0",
            major: 2,
            pseudo: []
        });

        const missing = await request(session, { ":path": "/nowhere" });
        assert.strictEqual(missing.headers[":status"], 404);
    } finally {
        session.close();
        await close();
    }
});

test("h2c: a body in, a body written in pieces out, and the headers HTTP/2 refuses left out", async () => {
    const { port, close } = await listen(http2.createServer(makeApp()));
    const session = http2.connect(`http://127.0.0.1:${port}`);
    try {
        const payload = Buffer.from("x".repeat(100000));
        const echo = await request(
            session,
            { ":path": "/echo", ":method": "POST", "content-length": String(payload.length) },
            payload
        );
        assert.ok(echo.body.equals(payload));

        const stream = await request(session, { ":path": "/stream" });
        assert.strictEqual(stream.body.toString(), "one,two,three");

        // Connection set by the app, and the keep-alive pair: either one makes node:http2 throw
        const closing = await request(session, { ":path": "/closing" });
        assert.strictEqual(closing.headers[":status"], 201);
        assert.strictEqual(closing.headers.connection, undefined);
        assert.strictEqual(closing.body.toString(), "created");

        const empty = await request(session, { ":path": "/empty" });
        assert.strictEqual(empty.headers[":status"], 204);
        assert.strictEqual(empty.headers["content-length"], undefined);
    } finally {
        session.close();
        await close();
    }
});

test("TLS with ALPN: h2 and HTTP/1.1 on one port, both https, the static twin negotiated", async (t) => {
    const warnings = /** @type {string[]} */ ([]);
    const onWarning = (/** @type {Error} */ warning) => warnings.push(warning.message);
    process.on("warning", onWarning);
    t.after(() => process.off("warning", onWarning));

    const { port, close } = await listen(http2.createSecureServer({ ...tls, allowHTTP1: true }, makeApp()));
    const session = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
    try {
        const who = JSON.parse((await request(session, { ":path": "/who" })).body.toString());
        assert.strictEqual(who.protocol, "https");
        assert.strictEqual(who.secure, true);
        assert.strictEqual(who.version, "2.0");

        const original = fs.readFileSync(path.join(__dirname, "..", "parts", "small-file.json"));
        const twin = await request(session, { ":path": "/static/small-file.json", "accept-encoding": "br" });
        assert.strictEqual(twin.headers[":status"], 200);
        const body = twin.headers["content-encoding"] === "br" ? zlib.brotliDecompressSync(twin.body) : twin.body;
        assert.ok(body.equals(original));

        const h1 = await new Promise((resolve, reject) => {
            https
                .get(`https://127.0.0.1:${port}/who`, { rejectUnauthorized: false }, (res) => {
                    let data = "";
                    res.on("data", (chunk) => (data += chunk));
                    res.on("end", () => resolve(JSON.parse(data)));
                })
                .on("error", reject);
        });
        assert.strictEqual(/** @type {any} */ (h1).version, "1.1");
        assert.strictEqual(/** @type {any} */ (h1).protocol, "https");
    } finally {
        session.close();
        await close();
    }
    // a reason phrase handed to node:http2 is a process warning
    assert.deepStrictEqual(warnings, []);
});
