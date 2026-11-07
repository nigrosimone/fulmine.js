// express.uwsUtils, the query, body and response of an app.uws() route. No Express counterpart, so
// not a comparison test: what is pinned is what the docs promise, over a real listen(). A body
// through content-length and chunked, the 413 and 400 a read answers by itself, a response in one
// call with the type its body implies, a stream with its failures, an abort send() survives, and
// compressor() answering with what express.compression() answers.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const net = require("node:net");
const zlib = require("node:zlib");
const { Readable } = require("node:stream");

const express = require("../../src/index.js");

const { query, guard, readBuffer, readText, readJson, readForm, send, compressor } = express.uwsUtils;

/**
 * Starts an app and answers its port plus a close helper.
 *
 * @param {(app: any) => void} setup
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
function serve(setup) {
    return new Promise((resolve) => {
        const app = express();
        setup(app);
        app.listen(0, () => {
            resolve({ port: app.address().port, close: () => new Promise((done) => app.close(() => done())) });
        });
    });
}

/**
 * Body in pieces with the bytes as sent, so the client's own decoding is not what is tested.
 *
 * @param {number} port
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<{status: number, headers: Headers, body: Buffer}>}
 */
async function ask(port, path, init) {
    const res = await fetch(`http://localhost:${port}${path}`, init);
    return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

/**
 * A request as bytes, and everything that came back until the server closed or `ms` passed.
 *
 * @param {number} port
 * @param {string} request
 * @param {number} [ms]
 * @returns {Promise<string>}
 */
function rawRequest(port, request, ms = 300) {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        let answer = "";
        socket.on("data", (chunk) => (answer += chunk.toString("latin1")));
        socket.on("error", () => resolve(answer));
        socket.on("close", () => resolve(answer));
        socket.write(request);
        setTimeout(() => socket.destroy(), ms);
    });
}

test("query() parses as req.query does, before the handler returns", async () => {
    const { port, close } = await serve((app) => {
        app.uws("get", "/q", (res, req) => {
            const q = query(req);
            send(res, 200, null, { a: q.a, b: q.b, c: q.c, proto: Object.getPrototypeOf(q) === Object.prototype });
        });
    });
    const res = await ask(port, "/q?a=1&b=x%20y&b=z&c=a+b");
    assert.deepEqual(JSON.parse(res.body.toString()), { a: "1", b: ["x y", "z"], c: "a b", proto: false });
    await close();
});

test("a read gets the body sent by content-length, chunked, in pieces, and empty", async () => {
    const { port, close } = await serve((app) => {
        app.uws("post", "/text", (res) => readText(res, (body) => send(res, 200, null, `[${body}]`)));
    });
    assert.equal((await ask(port, "/text", { method: "POST", body: "ciao è" })).body.toString(), "[ciao è]");
    assert.equal((await ask(port, "/text", { method: "POST" })).body.toString(), "[]");

    const chunked = await rawRequest(
        port,
        "POST /text HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n20\r\n3\r\nabc\r\n0\r\n\r\n"
    );
    assert.match(chunked, /\r\n\r\n\[20abc\]$/);

    const large = "x".repeat(90 * 1024);
    assert.equal((await ask(port, "/text", { method: "POST", body: large })).body.length, large.length + 2);
    await close();
});

test("readBuffer lends the bytes for the callback, a copy of them stays good", async () => {
    let kept;
    const { port, close } = await serve((app) => {
        app.uws("post", "/echo", (res) =>
            readBuffer(res, (body) => {
                kept = Buffer.from(body);
                send(res, 200, null, body);
            })
        );
    });
    const res = await ask(port, "/echo", { method: "POST", body: "hello" });
    assert.equal(res.body.toString(), "hello");
    assert.equal(res.headers.get("content-type"), "application/octet-stream");
    assert.equal(kept.toString(), "hello");
    await close();
});

test("readJson and readForm hand the value over, bad JSON answers 400 without the callback", async () => {
    let called = 0;
    const { port, close } = await serve((app) => {
        app.uws("post", "/json", (res) =>
            readJson(res, (body) => {
                called++;
                send(res, 200, null, { got: body === undefined ? "nothing" : body });
            })
        );
        app.uws("post", "/form", (res) => readForm(res, (body) => send(res, 200, null, { a: body.a })));
    });
    assert.deepEqual(JSON.parse((await ask(port, "/json", { method: "POST", body: '{"a":1}' })).body), {
        got: { a: 1 }
    });
    assert.deepEqual(JSON.parse((await ask(port, "/json", { method: "POST" })).body), { got: "nothing" });
    assert.equal(called, 2);

    const bad = await ask(port, "/json", { method: "POST", body: "{nope" });
    assert.equal(bad.status, 400);
    assert.equal(called, 2);

    assert.deepEqual(JSON.parse((await ask(port, "/form", { method: "POST", body: "a=1+2" })).body), { a: "1 2" });
    await close();
});

test("a body over the limit answers 413 without the callback, the limit taking bytes or a string", async () => {
    let called = 0;
    const handler = (limit) => (res) =>
        readText(
            res,
            () => {
                called++;
                send(res, 200, null, "read");
            },
            limit
        );
    const { port, close } = await serve((app) => {
        app.uws("post", "/default", handler());
        app.uws("post", "/number", handler({ limit: 4 }));
        app.uws("post", "/string", handler({ limit: "1kb" }));
    });
    assert.equal((await ask(port, "/number", { method: "POST", body: "12345" })).status, 413);
    assert.equal((await ask(port, "/string", { method: "POST", body: "x".repeat(1025) })).status, 413);
    assert.equal((await ask(port, "/default", { method: "POST", body: "x".repeat(102401) })).status, 413);
    assert.equal(called, 0);
    assert.equal((await ask(port, "/string", { method: "POST", body: "x".repeat(1024) })).status, 200);
    assert.equal(called, 1);
    await close();
    assert.throws(() => readText({ onAborted() {}, onData() {} }, () => {}, { limit: "nope" }), /is invalid/);
});

test("send() carries status, headers and the type its body implies", async () => {
    const { port, close } = await serve((app) => {
        app.uws("get", "/text", (res) => send(res, 201, { "x-a": "b" }, "hi"));
        app.uws("get", "/json", (res) => send(res, 200, null, { a: 1 }));
        app.uws("get", "/bytes", (res) => send(res, 200, null, Buffer.from("ab")));
        app.uws("get", "/own", (res) => send(res, 200, { "content-type": "text/html" }, "<p>"));
        app.uws("get", "/empty", (res) => send(res, 204));
    });
    const text = await ask(port, "/text");
    assert.equal(text.status, 201);
    assert.equal(text.headers.get("x-a"), "b");
    assert.equal(text.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(text.body.toString(), "hi");

    assert.equal((await ask(port, "/json")).headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal((await ask(port, "/bytes")).headers.get("content-type"), "application/octet-stream");

    const own = await rawRequest(port, "GET /own HTTP/1.1\r\nHost: x\r\n\r\n");
    assert.equal(own.match(/content-type/gi).length, 1);
    assert.match(own, /content-type: text\/html/i);

    const empty = await ask(port, "/empty");
    assert.equal(empty.status, 204);
    assert.equal(empty.body.length, 0);
    await close();
});

test("send() takes a stream, and a failure answers 500 or breaks the response, never a short 200", async () => {
    const { port, close } = await serve((app) => {
        app.uws("get", "/stream", (res) => send(res, 200, { "content-type": "text/plain" }, Readable.from(["a", "b"])));
        app.uws("get", "/empty", (res) => send(res, 200, null, Readable.from([])));
        app.uws("get", "/fails-first", (res) => {
            const stream = new Readable({
                read() {
                    this.destroy(new Error("disk"));
                }
            });
            send(res, 200, null, stream);
        });
        app.uws("get", "/fails-late", (res) => {
            const stream = new Readable({ read() {} });
            send(res, 200, null, stream);
            stream.push("half");
            setTimeout(() => stream.destroy(new Error("disk")), 20);
        });
    });
    assert.equal((await ask(port, "/stream")).body.toString(), "ab");
    assert.equal((await ask(port, "/empty")).status, 200);
    assert.equal((await ask(port, "/fails-first")).status, 500);
    await assert.rejects(ask(port, "/fails-late"));
    await close();
});

test("a client that does not read stops the stream, and gets all of it once it does", async () => {
    const size = 256 * 1024 * 1024;
    const piece = Buffer.alloc(1024 * 1024, 0x61);
    let pulled = 0;
    const { port, close } = await serve((app) => {
        app.uws("get", "/big", (res) => {
            const stream = new Readable({
                highWaterMark: piece.length,
                read() {
                    this.push(pulled < size ? piece : null);
                    pulled += piece.length;
                }
            });
            send(res, 200, null, stream);
        });
    });
    const socket = net.connect(port, "127.0.0.1");
    socket.pause();
    socket.write("GET /big HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    await new Promise((done) => setTimeout(done, 300));
    assert.ok(pulled < size / 2, `${pulled} bytes pulled for a client that read none`);

    let received = 0;
    await new Promise((done) => {
        socket.on("data", (chunk) => (received += chunk.length));
        socket.on("close", done);
        socket.resume();
    });
    assert.ok(received >= size, `${received} bytes received`);
    await close();
});

test("after an abort send() does nothing, and a stream is destroyed", async () => {
    let answered = 0;
    let destroyed = false;
    const { port, close } = await serve((app) => {
        app.uws("get", "/late", (res) => {
            guard(res);
            setTimeout(() => {
                send(res, 200, null, "late");
                answered++;
            }, 60);
        });
        app.uws("get", "/stream", (res) => {
            const stream = new Readable({ read() {} });
            stream.on("close", () => (destroyed = true));
            send(res, 200, null, stream);
            stream.push("first");
        });
    });
    await rawRequest(port, "GET /late HTTP/1.1\r\nHost: x\r\n\r\n", 10);
    await rawRequest(port, "GET /stream HTTP/1.1\r\nHost: x\r\n\r\n", 30);
    await new Promise((done) => setTimeout(done, 120));
    assert.equal(answered, 1);
    assert.equal(destroyed, true);
    await close();
});

test("compressor() answers the bytes and headers express.compression() answers", async () => {
    const body = JSON.stringify({ items: "x".repeat(4000) });
    const options = { encodings: ["br", "gzip"] };
    const compress = compressor(options);
    const { port, close } = await serve((app) => {
        app.uws("get", "/raw", (res, req) => {
            const encoding = compress.negotiate(req);
            compress.send(res, 200, { "content-type": "application/json; charset=utf-8" }, body, encoding);
        });
        app.get("/express", express.compression(options), (req, res) => {
            res.type("application/json").send(body);
        });
    });
    for (const accept of ["br", "gzip", "gzip, br", "gzip;q=0, br;q=0", "deflate"]) {
        const raw = await rawRequest(port, `GET /raw HTTP/1.1\r\nHost: x\r\nAccept-Encoding: ${accept}\r\n\r\n`);
        const viaExpress = await rawRequest(
            port,
            `GET /express HTTP/1.1\r\nHost: x\r\nAccept-Encoding: ${accept}\r\n\r\n`
        );
        const split = (text) => [
            text.slice(0, text.indexOf("\r\n\r\n")).toLowerCase(),
            text.slice(text.indexOf("\r\n\r\n"))
        ];
        const [rawHead, rawBytes] = split(raw);
        const [expressHead, expressBytes] = split(viaExpress);
        assert.equal(rawBytes, expressBytes, accept);
        for (const name of ["content-encoding", "vary", "content-type", "content-length"]) {
            assert.equal(
                rawHead.match(new RegExp(`${name}: .*`))?.[0],
                expressHead.match(new RegExp(`${name}: .*`))?.[0]
            );
        }
    }
    await close();
});

test("compressor() leaves alone what is small or not compressible, still naming Vary on the first", async () => {
    const compress = compressor();
    const { port, close } = await serve((app) => {
        app.uws("get", "/small", (res, req) => compress.send(res, 200, null, { a: 1 }, compress.negotiate(req)));
        app.uws("get", "/image", (res, req) =>
            compress.send(res, 200, { "content-type": "image/png" }, Buffer.alloc(4096), compress.negotiate(req))
        );
    });
    const request = (path) => rawRequest(port, `GET ${path} HTTP/1.1\r\nHost: x\r\nAccept-Encoding: gzip\r\n\r\n`);
    const small = await request("/small");
    assert.match(small, /vary: Accept-Encoding/i);
    assert.doesNotMatch(small, /content-encoding/i);
    assert.match(small, /\r\n\r\n\{"a":1\}$/);

    const image = await request("/image");
    assert.doesNotMatch(image, /content-encoding|vary/i);
    await close();
});

test("compressor() and lite use UTF-8 bytes at the compression threshold, as Express does", async () => {
    const reference = require("express")();
    const referenceCompression = require("compression");
    reference.set("etag", false);
    const cases = [];
    for (const [name, prefix] of [
        ["ASCII", "aaaaaa"],
        ["NUL", "a\0aa\0a"],
        ["Latin-1", "\u00e9\u00e9\u00e9"],
        ["BMP", "\u20ac\u20ac"],
        ["astral", "\ud83d\ude00aa"],
        ["lone high surrogates", "\ud800\ud800"],
        ["lone low surrogates", "\udc00\udc00"]
    ]) {
        for (const length of [7, 8, 9]) {
            const body = prefix + "x".repeat(length - 6);
            assert.equal(Buffer.byteLength(body), length);
            cases.push({ name: `${name} ${length} bytes`, body, threshold: 8 });
        }
    }
    for (const length of [7, 8, 9]) {
        cases.push({ name: `Buffer ${length} bytes`, body: Buffer.alloc(length, 0x61), threshold: 8 });
    }
    cases.push({ name: "empty string below threshold", body: "", threshold: 8 });
    cases.push({ name: "below fractional threshold", body: "\u00e9".repeat(4), threshold: 8.5 });
    cases.push({ name: "above fractional threshold", body: "\u20ac".repeat(3), threshold: 8.5 });
    for (const body of ["", "x", Buffer.alloc(0)]) {
        cases.push({ name: `${typeof body} with threshold zero`, body, threshold: 0 });
    }

    const { port, close } = await serve((app) => {
        for (const [i, { body, threshold }] of cases.entries()) {
            const options = { threshold };
            const compress = compressor(options);
            app.uws("get", `/raw/${i}`, (res, req) => {
                compress.send(res, 200, { "content-type": "text/plain; charset=utf-8" }, body, compress.negotiate(req));
            });
            const answer = (req, res) => res.type("text/plain").send(body);
            app.uwsLite.get(`/lite/${i}`, { compress: options }, answer);
            reference.get(`/reference/${i}`, referenceCompression(options), answer);
        }
    });
    const referenceServer = reference.listen(0);
    await new Promise((resolve) => referenceServer.once("listening", resolve));
    const referencePort = referenceServer.address().port;
    const request = (port, path, encoding) =>
        new Promise((resolve, reject) => {
            http.get({ port, path, headers: { "accept-encoding": encoding }, agent: false }, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("error", reject);
                res.on("end", () =>
                    resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
                );
            }).on("error", reject);
        });
    try {
        for (const encoding of ["gzip", "br"]) {
            for (const [i, { name, body, threshold }] of cases.entries()) {
                const expected = await request(referencePort, `/reference/${i}`, encoding);
                const compressed = Buffer.byteLength(body) >= threshold;
                assert.equal(expected.headers["content-encoding"], compressed ? encoding : undefined, name);
                for (const route of ["raw", "lite"]) {
                    const actual = await request(port, `/${route}/${i}`, encoding);
                    const label = `${route} ${encoding} ${name}`;
                    assert.equal(actual.status, expected.status, label);
                    for (const header of ["content-type", "content-encoding", "vary"]) {
                        assert.equal(actual.headers[header], expected.headers[header], `${label} ${header}`);
                    }
                    if (!compressed) {
                        assert.equal(actual.headers["content-length"], expected.headers["content-length"], label);
                        assert.equal(Number(actual.headers["content-length"]), Buffer.byteLength(body), label);
                    }
                    assert.deepStrictEqual(actual.body, expected.body, label);
                    const decoded = !compressed
                        ? actual.body
                        : encoding === "gzip"
                          ? zlib.gunzipSync(actual.body)
                          : zlib.brotliDecompressSync(actual.body);
                    assert.deepStrictEqual(decoded, Buffer.from(body), label);
                }
            }
        }
    } finally {
        await close();
        await new Promise((resolve) => referenceServer.close(resolve));
    }
});

test("compressor() over the sync limit goes through the pool, and a stream through the encoder", async () => {
    const compress = compressor({ encodings: ["gzip"] });
    const large = "x".repeat(64 * 1024);
    const { port, close } = await serve((app) => {
        app.uws("get", "/large", (res, req) => compress.send(res, 200, null, large, compress.negotiate(req)));
        app.uws("get", "/stream", (res, req) =>
            compress.send(res, 200, { "content-type": "text/plain" }, Readable.from([large]), compress.negotiate(req))
        );
    });
    // fetch decodes it, which is the check
    for (const path of ["/large", "/stream"]) {
        const res = await ask(port, path, { headers: { "accept-encoding": "gzip" } });
        assert.equal(res.headers.get("content-encoding"), "gzip");
        assert.equal(res.body.toString(), large);
    }
    await close();
});

test("compressor() names no encoding for a client that sent none, unless enforceEncoding says", async () => {
    const plain = compressor();
    const enforced = compressor({ enforceEncoding: "gzip" });
    const body = "y".repeat(2048);
    const { port, close } = await serve((app) => {
        app.uws("get", "/plain", (res, req) => plain.send(res, 200, null, body, plain.negotiate(req)));
        app.uws("get", "/enforced", (res, req) => enforced.send(res, 200, null, body, enforced.negotiate(req)));
    });
    assert.doesNotMatch(await rawRequest(port, "GET /plain HTTP/1.1\r\nHost: x\r\n\r\n"), /content-encoding/i);
    const answer = await rawRequest(port, "GET /enforced HTTP/1.1\r\nHost: x\r\n\r\n");
    assert.match(answer, /content-encoding: gzip/i);
    const bytes = Buffer.from(answer.slice(answer.indexOf("\r\n\r\n") + 4), "latin1");
    assert.equal(zlib.gunzipSync(bytes).toString(), body);
    await close();
});
