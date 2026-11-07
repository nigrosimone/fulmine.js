// app.uwsLite(): the same handler on a plain route and on a lite route has to answer the same, ETag and
// X-Powered-By apart, which a lite route does not write. Then what is only a lite route's: the Express
// route it registers for what µWS does not serve, what req keeps after the handler returned, an abort.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const net = require("node:net");
const { Readable } = require("node:stream");
const zlib = require("node:zlib");

const express = require("../../src/index.js");

/**
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
 * @param {number} port
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<{status: number, type: string|null, length: string|null, cookies: string[], body: string}>}
 */
async function call(port, path, init) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return {
        status: res.status,
        type: res.headers.get("content-type"),
        length: res.headers.get("content-length"),
        cookies: res.headers.getSetCookie(),
        body: await res.text()
    };
}

/** Raw bytes in, raw bytes out, until the server closes or the wait runs out. */
function raw(port, text, wait = 300) {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
        let out = "";
        socket.on("data", (chunk) => (out += chunk));
        socket.on("error", () => {});
        const timer = setTimeout(() => socket.destroy(), wait);
        socket.on("close", () => {
            clearTimeout(timer);
            resolve(out);
        });
    });
}

const POST = (body, type = "text/plain") => ({ method: "POST", body, headers: { "content-type": type } });

const CASES = [
    ["a string is html", {}, (req, res) => res.send("hi"), "/r"],
    ["res.type with a name", {}, (req, res) => res.type("txt").send("hi"), "/r"],
    ["res.type with a mime type", {}, (req, res) => res.type("text/plain").send("hi"), "/r"],
    ["res.set of the content-type", {}, (req, res) => res.set("Content-Type", "text/plain").send("hi"), "/r"],
    ["res.set of an extension", {}, (req, res) => res.set("Content-Type", "html").send("hi"), "/r"],
    ["a charset is replaced", {}, (req, res) => res.set("content-type", "text/plain; charset=latin1").send("hi"), "/r"],
    ["res.json", {}, (req, res) => res.json({ a: 1 }), "/r"],
    ["res.json of a string", {}, (req, res) => res.json("x"), "/r"],
    ["res.json keeps a type", {}, (req, res) => res.type("application/vnd.x+json").json({ a: 1 }), "/r"],
    ["an object", {}, (req, res) => res.send({ a: [1, 2] }), "/r"],
    ["a number", {}, (req, res) => res.send(7), "/r"],
    ["a boolean", {}, (req, res) => res.send(false), "/r"],
    ["null", {}, (req, res) => res.send(null), "/r"],
    ["nothing", {}, (req, res) => res.send(), "/r"],
    ["a Buffer", {}, (req, res) => res.send(Buffer.from("bytes")), "/r"],
    ["a Buffer with a type", {}, (req, res) => res.type("png").send(Buffer.from("bytes")), "/r"],
    ["res.end", {}, (req, res) => res.end("x"), "/r"],
    ["res.end empty", {}, (req, res) => res.end(), "/r"],
    ["a status", {}, (req, res) => res.status(201).send("x"), "/r"],
    ["204", {}, (req, res) => res.status(204).send("gone"), "/r"],
    ["sendStatus", {}, (req, res) => res.sendStatus(404), "/r"],
    ["sendStatus 204", {}, (req, res) => res.sendStatus(204), "/r"],
    ["cookies", {}, (req, res) => res.set("Set-Cookie", ["a=1", "b=2"]).send("x"), "/r"],
    ["an object of headers", {}, (req, res) => res.set({ "Content-Type": "text/plain" }).send("x"), "/r"],
    ["res.get", {}, (req, res) => res.set("x-a", "1").send(String(res.get("X-A"))), "/r"],
    [
        "res.headersSent",
        {},
        (req, res) => {
            const before = res.headersSent;
            res.send(String(before));
        },
        "/r"
    ],
    ["a query", {}, (req, res) => res.json(req.query), "/r?a=1&a=2&b=x%20y&c=+"],
    ["req.path and req.url", {}, (req, res) => res.json([req.path, req.url, req.method]), "/r?a=1"],
    ["a header", {}, (req, res) => res.send(String(req.get("X-Test"))), "/r", { headers: { "x-test": "v" } }],
    ["no such header", {}, (req, res) => res.send(String(req.get("x-none"))), "/r"],
    ["a text body", { body: "text" }, (req, res) => res.json(req.body), "/r", POST("héllo")],
    ["a BOM", { body: "text" }, (req, res) => res.json(req.body), "/r", POST("﻿x")],
    ["a json body", { body: "json" }, (req, res) => res.json(req.body), "/r", POST('{"a":1}')],
    ["a form", { body: "form" }, (req, res) => res.json(req.body), "/r", POST("a=1&b=2&a=3")],
    ["bytes", { body: "buffer" }, (req, res) => res.send(req.body), "/r", POST("abc")],
    ["limit as a string", { body: "text", limit: "1kb" }, (req, res) => res.send(req.body), "/r", POST("abc")],
    ["empty json", { body: "json" }, (req, res) => res.json(req.body), "/r", POST("")],
    ["empty text", { body: "text" }, (req, res) => res.json(req.body), "/r", POST("")]
];

for (const [name, options, handler, url, init] of CASES) {
    test(`as Express: ${name}`, async () => {
        const verb = init?.method === "POST" ? "post" : "get";
        const parsers = { text: express.text, json: express.json, form: express.urlencoded, buffer: express.raw };
        const plain = await serve((app) => {
            app.set("etag", false);
            const before =
                options.body === undefined ? [] : [parsers[options.body]({ type: () => true, limit: options.limit })];
            app[verb]("/r", ...before, handler);
        });
        const lite = await serve((app) => app.uwsLite(verb, "/r", options, handler));
        const expected = await call(plain.port, url, init);
        const actual = await call(lite.port, url, init);
        await plain.close();
        await lite.close();
        assert.deepStrictEqual(actual, expected);
    });
}

test("a parameter is decoded and has the name of the path", async () => {
    const app = await serve((a) => {
        a.uwsLite("get", "/u/:id/p/:page", (req, res) => res.json(req.params));
    });
    assert.deepStrictEqual(JSON.parse((await call(app.port, "/u/a%20b/p/2")).body), { id: "a b", page: "2" });
    assert.strictEqual((await call(app.port, "/u/%zz/p/2")).status, 400);
    await app.close();
});

test("a mount with a parameter does not shift the route's own", async () => {
    const app = await serve((a) => {
        const router = express.Router();
        router.uwsLite("get", "/:id", (req, res) => res.json(req.params));
        a.use("/t/:tenant", router);
    });
    assert.deepStrictEqual(JSON.parse((await call(app.port, "/t/acme/7")).body), { id: "7" });
    await app.close();
});

test("invalid JSON and strict JSON are a 400 and the handler does not run", async () => {
    let ran = 0;
    const app = await serve((a) => {
        a.uwsLite("post", "/j", { body: "json" }, (req, res) => {
            ran++;
            res.end();
        });
    });
    assert.strictEqual((await call(app.port, "/j", POST("{nope"))).status, 400);
    assert.strictEqual((await call(app.port, "/j", POST("20"))).status, 400);
    assert.strictEqual((await call(app.port, "/j", POST("null"))).status, 400);
    assert.strictEqual(ran, 0);
    await app.close();
});

test("over the limit is a 413, the handler does not run and the connection goes on", async () => {
    let ran = 0;
    const app = await serve((a) => {
        a.uwsLite("post", "/l", { body: "text", limit: 2 }, (req, res) => {
            ran++;
            res.end();
        });
    });
    assert.strictEqual((await call(app.port, "/l", POST("abc"))).status, 413);
    assert.strictEqual((await call(app.port, "/l", POST("ab"))).status, 200);
    assert.strictEqual(ran, 1);
    await app.close();
});

test("a body in chunks, and in more than one read", async () => {
    const app = await serve((a) => {
        a.uwsLite("post", "/e", { body: "text" }, (req, res) => res.send(req.body));
    });
    const chunked = await raw(
        app.port,
        "POST /e HTTP/1.1\r\nHost: x\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"
    );
    assert.match(chunked, /abcde$/);

    const socket = net.connect(app.port, "127.0.0.1");
    let out = "";
    socket.on("data", (chunk) => (out += chunk));
    socket.write("POST /e HTTP/1.1\r\nHost: x\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc");
    await new Promise((done) => setTimeout(done, 30));
    socket.write("def");
    await new Promise((done) => socket.on("close", done));
    assert.match(out, /abcdef$/);
    await app.close();
});

test("the Express route serves what µWS does not: a HEAD, a trailing slash, createServer", async () => {
    const setup = (a) => {
        a.uwsLite("get", "/r", (req, res) => res.type("txt").send("hello"));
        a.uwsLite("post", "/p", { body: "json" }, (req, res) => res.json(req.body));
    };
    const app = await serve(setup);
    const head = await fetch(`http://127.0.0.1:${app.port}/r`, { method: "HEAD" });
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.headers.get("content-length"), "5");
    assert.strictEqual((await call(app.port, "/r/")).body, "hello");
    await app.close();

    const shimmed = express();
    setup(shimmed);
    const server = http.createServer(shimmed);
    await new Promise((done) => server.listen(0, done));
    const port = server.address().port;
    assert.strictEqual((await call(port, "/r")).body, "hello");
    assert.strictEqual((await call(port, "/p", POST('{"a":1}', "application/json"))).body, '{"a":1}');
    await new Promise((done) => server.close(done));
});

test("an async handler answers later, with the query and the params it had", async () => {
    const app = await serve((a) => {
        a.uwsLite("get", "/late/:id", async (req, res) => {
            await new Promise((done) => setTimeout(done, 5));
            res.status(201).json({ id: req.params.id, q: req.query.q });
        });
        a.uwsLite("post", "/late", { body: "text" }, async (req, res) => {
            await new Promise((done) => setTimeout(done, 5));
            res.send(req.body);
        });
    });
    const answer = await call(app.port, "/late/7?q=1");
    assert.strictEqual(answer.status, 201);
    assert.deepStrictEqual(JSON.parse(answer.body), { id: "7", q: "1" });
    assert.strictEqual((await call(app.port, "/late", POST("body"))).body, "body");
    await app.close();
});

test("req after the handler returned: declared it answers, not declared it says so", async () => {
    /** @type {any[]} */
    const seen = [];
    const later = async (req, res) => {
        await new Promise((done) => setTimeout(done, 5));
        for (const read of [() => req.get("x-kept"), () => req.path, () => req.url, () => req.get("x-other")]) {
            try {
                seen.push(read());
            } catch (error) {
                seen.push(error.constructor.name);
            }
        }
        res.end();
    };
    const app = await serve((a) => {
        a.uwsLite("get", "/kept", { headers: ["X-Kept"], url: true }, later);
        a.uwsLite("get", "/not", later);
    });
    await call(app.port, "/kept?a=1", { headers: { "x-kept": "yes", "x-other": "no" } });
    assert.deepStrictEqual(seen, ["yes", "/kept", "/kept?a=1", "TypeError"]);
    seen.length = 0;
    await call(app.port, "/not", { headers: { "x-kept": "yes" } });
    assert.deepStrictEqual(seen, ["TypeError", "TypeError", "TypeError", "TypeError"]);
    await app.close();
});

test("a route on any method says which one", async () => {
    const app = await serve((a) => {
        a.uwsLite("any", "/m", (req, res) => res.send(req.method));
    });
    assert.strictEqual((await call(app.port, "/m", { method: "PUT" })).body, "PUT");
    assert.strictEqual((await call(app.port, "/m")).body, "GET");
    await app.close();
});

test("a throw and a rejection are a 500, and one after the answer leaves it alone", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const app = await serve((a) => {
        a.uwsLite("get", "/throw", (req, res) => {
            res.set("x-a", "1");
            throw new Error("boom");
        });
        a.uwsLite("get", "/reject", async () => {
            await null;
            throw new Error("boom");
        });
        a.uwsLite("get", "/after", (req, res) => {
            res.send("ok");
            throw new Error("boom");
        });
    });
    const thrown = await fetch(`http://127.0.0.1:${app.port}/throw`);
    assert.strictEqual(thrown.status, 500);
    assert.strictEqual(thrown.headers.get("x-a"), null);
    assert.strictEqual((await call(app.port, "/reject")).status, 500);
    assert.strictEqual((await call(app.port, "/after")).body, "ok");
    process.env.NODE_ENV = before;
    await app.close();
});

test("a header with a line break is refused and not written", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const app = await serve((a) => {
        a.uwsLite("get", "/h", (req, res) => res.set("x-a", "1\r\nx-b: 2").send("x"));
        a.uwsLite("get", "/n", (req, res) => res.set("x a", "1").send("x"));
        a.uwsLite("get", "/t", (req, res) => res.set("content-type", "text/plain\r\nx-b: 2").send("x"));
        a.uwsLite("get", "/e", (req, res) => res.set("content-type", "a/b\r\nx-b: 2").end("x"));
        a.uwsLite("get", "/b", (req, res) => res.type("a/b\r\nx-b: 2").send(Buffer.from("x")));
    });
    for (const path of ["/h", "/n", "/t", "/e", "/b"]) {
        const answer = await raw(app.port, `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        assert.match(answer, /^HTTP\/1\.1 500 /);
        assert.doesNotMatch(answer, /x-b/);
    }
    process.env.NODE_ENV = before;
    await app.close();
});

test("a second answer throws, as Express", async () => {
    /** @type {unknown} */
    let second;
    const app = await serve((a) => {
        a.uwsLite("get", "/two", (req, res) => {
            res.send("one");
            try {
                res.send("two");
            } catch (error) {
                second = error;
            }
        });
    });
    assert.strictEqual((await call(app.port, "/two")).body, "one");
    assert.match(String(second), /Cannot set headers after they are sent/);
    await app.close();
});

test("a client gone during the wait: the late answer does nothing and the server goes on", async () => {
    /** @type {() => void} */
    let finished;
    const done = new Promise((resolve) => (finished = resolve));
    const app = await serve((a) => {
        a.uwsLite("get", "/gone", async (req, res) => {
            await new Promise((wake) => setTimeout(wake, 60));
            res.send("nobody");
            finished();
        });
        a.uwsLite("get", "/next", (req, res) => res.send("alive"));
    });
    const socket = net.connect(app.port, "127.0.0.1", () => socket.write("GET /gone HTTP/1.1\r\nHost: x\r\n\r\n"));
    socket.on("error", () => {});
    await new Promise((wake) => setTimeout(wake, 15));
    socket.destroy();
    await done;
    assert.strictEqual((await call(app.port, "/next")).body, "alive");
    await app.close();
});

test("a client gone in the middle of the body: no handler, and the server goes on", async () => {
    let ran = 0;
    const app = await serve((a) => {
        a.uwsLite("post", "/b", { body: "text" }, (req, res) => {
            ran++;
            res.end();
        });
        a.uwsLite("get", "/next", (req, res) => res.send("alive"));
    });
    const socket = net.connect(app.port, "127.0.0.1", () => {
        socket.write("POST /b HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nabc");
    });
    socket.on("error", () => {});
    await new Promise((wake) => setTimeout(wake, 15));
    socket.destroy();
    await new Promise((wake) => setTimeout(wake, 15));
    assert.strictEqual(ran, 0);
    assert.strictEqual((await call(app.port, "/next")).body, "alive");
    await app.close();
});

test("a lent body is the bytes while the handler runs", async () => {
    const app = await serve((a) => {
        a.uwsLite("post", "/l", { body: "lent" }, (req, res) => res.send(req.body));
    });
    assert.strictEqual((await call(app.port, "/l", POST("abc"))).body, "abc");
    await app.close();
});

test("a Buffer body can be kept past the handler", async () => {
    /** @type {Buffer[]} */
    const kept = [];
    const app = await serve((a) => {
        a.uwsLite("post", "/k", { body: "buffer" }, (req, res) => {
            kept.push(req.body);
            res.end();
        });
    });
    await call(app.port, "/k", POST("abc"));
    await call(app.port, "/k", POST("xyz"));
    assert.strictEqual(kept[0].toString(), "abc");
    await app.close();
});

test("compress: the bytes express.compression() writes", async () => {
    const big = "x".repeat(4096);
    const options = { encodings: ["gzip"] };
    const plain = await serve((a) => {
        a.set("etag", false);
        a.get("/c", express.compression(options), (req, res) => res.type("txt").send(big));
    });
    const lite = await serve((a) => {
        a.uwsLite("get", "/c", { compress: options }, (req, res) => res.type("txt").send(big));
        a.uwsLite("get", "/small", { compress: options }, (req, res) => res.send("x"));
        a.uwsLite("get", "/image", { compress: options }, (req, res) => res.type("png").send(Buffer.alloc(4096)));
    });
    const fetchRaw = (port, path) =>
        new Promise((resolve) => {
            http.get({ port, path, headers: { "accept-encoding": "gzip" } }, (res) => {
                /** @type {Buffer[]} */
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
            });
        });
    const expected = /** @type {any} */ (await fetchRaw(plain.port, "/c"));
    const actual = /** @type {any} */ (await fetchRaw(lite.port, "/c"));
    assert.strictEqual(actual.headers["content-encoding"], "gzip");
    assert.strictEqual(actual.headers.vary, expected.headers.vary);
    assert.strictEqual(actual.headers["content-type"], expected.headers["content-type"]);
    assert.strictEqual(zlib.gunzipSync(actual.body).toString(), big);
    assert.deepStrictEqual(actual.body, expected.body);
    const small = /** @type {any} */ (await fetchRaw(lite.port, "/small"));
    assert.strictEqual(small.headers["content-encoding"], undefined);
    const image = /** @type {any} */ (await fetchRaw(lite.port, "/image"));
    assert.strictEqual(image.headers["content-encoding"], undefined);
    await plain.close();
    await lite.close();
});

test("cork: left to µWS while it holds one, asked for after the handler returned", async () => {
    /** @type {string[]} */
    const calls = [];
    const fakeRes = () => ({
        cork(write) {
            calls.push("cork");
            write();
        },
        onAborted() {},
        writeHeader() {
            return this;
        },
        end() {
            calls.push("end");
        }
    });
    const fakeReq = { getQuery: () => "", getUrl: () => "/", getHeader: () => "" };
    const { makeLiteRoute } = require("../../src/uws-lite.js");

    makeLiteRoute("get", "/", {}, (req, res) => res.send("x")).uws(fakeRes(), fakeReq);
    assert.deepStrictEqual(calls, ["end"]);

    calls.length = 0;
    /** @type {any} */
    let later;
    makeLiteRoute("get", "/", {}, (req, res) => {
        later = res;
    }).uws(fakeRes(), fakeReq);
    later.send("x");
    assert.deepStrictEqual(calls, ["cork", "end"]);

    calls.length = 0;
    /** @type {any} */
    const res = fakeRes();
    /** @type {any} */
    let collected;
    res.collectBody = (limit, done) => {
        collected = done;
    };
    makeLiteRoute("post", "/", { body: "text" }, (req, r) => r.send("x")).uws(res, fakeReq);
    collected(new ArrayBuffer(1));
    assert.deepStrictEqual(calls, ["end"]);
});

/** Records the wire writes, rejecting any made outside the native or an explicit cork. */
function compressedCorkProbe(accept) {
    const state = { native: true, depth: 0, corks: 0, headers: {}, chunks: [], collected: null };
    let finish;
    const done = new Promise((resolve) => (finish = resolve));
    const check = () => assert(state.native || state.depth > 0, "write outside a cork");
    const res = {
        cork(write) {
            state.corks++;
            state.depth++;
            try {
                write();
            } finally {
                state.depth--;
            }
        },
        onAborted() {},
        collectBody(limit, callback) {
            state.collected = callback;
        },
        writeHeader(name, value) {
            check();
            state.headers[String(name)] = String(value);
            return this;
        },
        write(chunk) {
            check();
            state.chunks.push(Buffer.from(chunk));
            return true;
        },
        end(chunk) {
            check();
            if (chunk !== undefined) state.chunks.push(Buffer.from(chunk));
            finish();
        }
    };
    const req = { getQuery: () => "", getUrl: () => "/", getHeader: () => accept, forEach() {} };
    return { state, res, req, done };
}

for (const [name, accept, body, encoding] of [
    ["identity", "", "x".repeat(4096), undefined],
    ["below threshold", "gzip", "small", undefined],
    ["gzip", "gzip", "x".repeat(4096), "gzip"],
    ["brotli", "br", "x".repeat(4096), "br"]
]) {
    test(`cork: compression ${name} keeps the native cork only for a synchronous answer`, async () => {
        const { makeLiteRoute } = require("../../src/uws-lite.js");
        for (const mode of ["sync", "later", "body", "middleware"]) {
            const probe = compressedCorkProbe(accept);
            const options = { compress: { encodings: ["gzip", "br"] } };
            if (mode === "body") options.body = "text";
            if (mode === "middleware") {
                options.use = [
                    async (req, res, next) => {
                        await Promise.resolve();
                        next();
                    }
                ];
            }
            const handler = (req, res) => {
                if (mode === "later") return Promise.resolve().then(() => res.type("txt").send(body));
                res.type("txt").send(body);
            };
            makeLiteRoute(mode === "body" ? "post" : "get", "/", options, handler).uws(probe.res, probe.req);
            // collectBody invokes the handler under µWS's cork too, after the request callback.
            if (mode === "body") probe.state.collected(new ArrayBuffer(0));
            probe.state.native = false;
            await probe.done;
            assert.strictEqual(probe.state.corks, mode === "sync" || mode === "body" ? 0 : 1, mode);
            assert.strictEqual(probe.state.headers.vary, "Accept-Encoding", mode);
            assert.strictEqual(probe.state.headers["content-type"], "text/plain; charset=utf-8", mode);
            assert.strictEqual(probe.state.headers["content-encoding"], encoding, mode);
            const output = Buffer.concat(probe.state.chunks);
            const decoded =
                encoding === "gzip"
                    ? zlib.gunzipSync(output)
                    : encoding === "br"
                      ? zlib.brotliDecompressSync(output)
                      : output;
            assert.strictEqual(decoded.toString(), body, mode);
        }
    });
}

test("cork: asynchronous compression and streams still cork their writes", async () => {
    const { makeLiteRoute } = require("../../src/uws-lite.js");
    for (const mode of ["pool", "stream", "identity stream"]) {
        const probe = compressedCorkProbe(mode === "identity stream" ? "" : "gzip");
        const body = "x".repeat(mode === "pool" ? 32 * 1024 : 4096);
        const handler = (req, res) => {
            res.type("txt");
            if (mode === "pool") res.send(body);
            else Readable.from([body.slice(0, 2048), body.slice(2048)]).pipe(res);
        };
        makeLiteRoute("get", "/", { compress: { encodings: ["gzip"] } }, handler).uws(probe.res, probe.req);
        probe.state.native = false;
        await probe.done;
        assert(probe.state.corks > 0, mode);
        assert.strictEqual(probe.state.headers.vary, "Accept-Encoding", mode);
        const output = Buffer.concat(probe.state.chunks);
        const decoded = mode === "identity stream" ? output : zlib.gunzipSync(output);
        assert.strictEqual(decoded.toString(), body, mode);
    }

    // Raw utility callers have no implicit cork guarantee to pass on.
    const { compressor } = require("../../src/uws-utils.js");
    const probe = compressedCorkProbe("");
    probe.state.native = false;
    compressor().send(probe.res, 200, null, "raw", "");
    await probe.done;
    assert.strictEqual(probe.state.corks, 1);
    assert.strictEqual(Buffer.concat(probe.state.chunks).toString(), "raw");
});

test("a bad registration throws where it is written", () => {
    const app = express();
    const handler = () => {};
    assert.throws(() => app.uwsLite("get", "/a/*", handler), /takes no \*/);
    assert.throws(() => app.uwsLite("get", "/a", {}), /handler/);
    assert.throws(() => app.uwsLite("get", "/a", { body: "xml" }, handler), /option body/);
    assert.throws(() => app.uwsLite("get", "/a", { limit: "lots" }, handler), /limit/);
    assert.throws(() => app.uwsLite("nope", "/a", handler));
});

// middleware: the chain runs on µWS's route and on the Express route it registers

/** Two ways to reach one route: µWS, and the Express route over HTTP/1.1 on createServer. */
async function bothWays(setup, check) {
    const lite = await serve(setup);
    try {
        await check(lite.port);
    } finally {
        await lite.close();
    }
    const app = express();
    setup(app);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
        await check(server.address().port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

/** Connects, writes, and leaves after a moment. */
function leave(port, text) {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1", () => {
            socket.write(text);
            setTimeout(() => {
                socket.destroy();
                resolve();
            }, 30);
        });
    });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("middleware runs in order, sees the body and hands values to the handler", async () => {
    const use = [
        (req, res, next) => {
            req.seen = [req.body.a];
            next();
        },
        async (req, res, next) => {
            await wait(5);
            req.seen.push(req.get("x-one"), req.headers["x-one"], req.method, req.path);
            next();
        }
    ];
    await bothWays(
        (app) => app.uwsLite("post", "/m", { body: "json", use }, (req, res) => res.json(req.seen)),
        async (port) => {
            const answer = await call(port, "/m", {
                method: "POST",
                headers: { "content-type": "application/json", "x-one": "1" },
                body: '{"a":7}'
            });
            assert.strictEqual(answer.body, '[7,"1","1","POST","/m"]');
        }
    );
});

test("middleware that answers stops the chain", async () => {
    let handled = 0;
    const use = [(req, res) => res.status(403).send("no")];
    await bothWays(
        (app) => app.uwsLite("get", "/m", { use }, (req, res) => res.send(String(++handled))),
        async (port) => {
            const answer = await call(port, "/m");
            assert.strictEqual(answer.status, 403);
            assert.strictEqual(answer.body, "no");
        }
    );
    assert.strictEqual(handled, 0);
});

test("an error skips to the middleware with four parameters", async () => {
    for (const fail of [
        (req, res, next) => next(new Error("x")),
        () => {
            throw new Error("x");
        },
        async () => {
            throw new Error("x");
        }
    ]) {
        const skipped = (req, res, next) => {
            res.set("x-skipped", "1");
            next();
        };
        const use = [fail, skipped, (err, req, res, next) => res.status(418).send(err.message)];
        await bothWays(
            (app) => app.uwsLite("get", "/m", { use }, (req, res) => res.send("no")),
            async (port) => {
                const res = await fetch(`http://127.0.0.1:${port}/m`);
                assert.strictEqual(res.status, 418);
                assert.strictEqual(res.headers.get("x-skipped"), null);
                assert.strictEqual(await res.text(), "x");
            }
        );
    }
});

test("an error nobody handles answers its status, and 500 without one", async () => {
    const status = (code) => (req, res, next) => next(Object.assign(new Error("x"), { status: code }));
    await bothWays(
        (app) => {
            app.uwsLite("get", "/401", { use: [status(401)] }, (req, res) => res.send("no"));
            app.uwsLite("get", "/200", { use: [status(200)] }, (req, res) => res.send("no"));
            app.uwsLite("get", "/plain", { use: [(req, res, next) => next(new Error("x"))] }, (req, res) =>
                res.send("no")
            );
            app.uwsLite("get", "/handler", () => {
                throw Object.assign(new Error("x"), { statusCode: 404 });
            });
        },
        async (port) => {
            assert.strictEqual((await call(port, "/401")).status, 401);
            assert.strictEqual((await call(port, "/200")).status, 500);
            assert.strictEqual((await call(port, "/plain")).status, 500);
            assert.strictEqual((await call(port, "/handler")).status, 404);
        }
    );
});

test("helmet and cors write what they write on an Express route", async () => {
    const helmet = require("helmet");
    const cors = require("cors");
    const server = await serve((app) => {
        const use = [helmet(), cors({ origin: "http://a.test", credentials: true })];
        app.get("/plain", ...use, (req, res) => res.json({ a: 1 }));
        app.uwsLite("get", "/lite", { use }, (req, res) => res.json({ a: 1 }));
    });
    try {
        const headers = { origin: "http://a.test" };
        const [plain, lite] = await Promise.all(
            ["/plain", "/lite"].map((path) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers }))
        );
        const names = [...plain.headers.keys()].filter(
            (name) => !["date", "etag", "x-powered-by", "connection", "keep-alive", "uwebsockets"].includes(name)
        );
        assert.ok(names.includes("content-security-policy"));
        assert.ok(names.includes("access-control-allow-origin"));
        for (const name of names) {
            assert.strictEqual(lite.headers.get(name), plain.headers.get(name), name);
        }
    } finally {
        await server.close();
    }
});

test("a cors preflight ends in the middleware, with no body headers", async () => {
    const cors = require("cors");
    const server = await serve((app) => {
        app.uwsLite("any", "/lite", { use: [cors()] }, (req, res) => res.send("no"));
    });
    try {
        const out = await raw(
            server.port,
            "OPTIONS /lite HTTP/1.1\r\nHost: x\r\nOrigin: http://a.test\r\nAccess-Control-Request-Method: PUT\r\nConnection: close\r\n\r\n"
        );
        assert.match(out, /^HTTP\/1\.1 204/);
        assert.match(out, /access-control-allow-methods/i);
        assert.doesNotMatch(out, /content-length: 0\r\n[\s\S]*content-length/i);
    } finally {
        await server.close();
    }
});

test("res.set of a content-length leaves it to µWS", async () => {
    const server = await serve((app) => {
        app.uwsLite("get", "/lite", (req, res) => res.set("Content-Length", "2").send("hello"));
    });
    try {
        const out = await raw(server.port, "GET /lite HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        assert.strictEqual(out.match(/content-length/gi).length, 1);
        assert.match(out, /hello$/);
    } finally {
        await server.close();
    }
});

test("the same request header twice is joined, cookies with a semicolon", async () => {
    const server = await serve((app) => {
        const use = [(req, res, next) => next()];
        app.uwsLite("get", "/lite", { use }, (req, res) => res.json(req.headers));
    });
    try {
        const out = await raw(
            server.port,
            "GET /lite HTTP/1.1\r\nHost: x\r\nX-A: 1\r\nX-A: 2\r\nCookie: a=1\r\nCookie: b=2\r\nConnection: close\r\n\r\n"
        );
        assert.match(out, /"x-a":"1, 2"/);
        assert.match(out, /"cookie":"a=1; b=2"/);
    } finally {
        await server.close();
    }
});

test("finish tells a middleware the answer is out, once, with the status", async () => {
    for (const handler of [
        (req, res) => res.status(201).send("hi"),
        async (req, res) => {
            await wait(5);
            res.status(201).send("hi");
        },
        (req, res) => {
            res.status(201);
            Readable.from(["h", "i"]).pipe(res);
        }
    ]) {
        const events = [];
        const use = [
            (req, res, next) => {
                res.on("finish", () => events.push(`finish ${res.statusCode}`));
                res.once("close", () => events.push("close"));
                next();
            }
        ];
        const server = await serve((app) => app.uwsLite("get", "/m", { use }, handler));
        try {
            const answer = await call(server.port, "/m");
            assert.strictEqual(answer.body, "hi");
            await wait(20);
            assert.deepStrictEqual(events, ["finish 201", "close"]);
        } finally {
            await server.close();
        }
    }
});

test("a client gone during async middleware reaches no handler and breaks nothing", async () => {
    let handled = 0;
    let release;
    const waited = new Promise((resolve) => (release = resolve));
    const closed = [];
    const use = [
        async (req, res, next) => {
            res.on("close", () => closed.push("close"));
            await waited;
            next();
        }
    ];
    const server = await serve((app) => app.uwsLite("get", "/m", { use }, () => handled++));
    try {
        await leave(server.port, "GET /m HTTP/1.1\r\nHost: x\r\n\r\n");
        await wait(30);
        release();
        await wait(20);
        assert.strictEqual(handled, 0);
        assert.deepStrictEqual(closed, ["close"]);
    } finally {
        await server.close();
    }
});

test("a route without middleware keeps no headers and pays no listener", async () => {
    let seen;
    const server = await serve((app) => {
        app.uwsLite("get", "/lite", (req, res) => {
            seen = [req.headers, res.listenerCount("finish"), res.emit("finish")];
            res.send("ok");
        });
    });
    try {
        await call(server.port, "/lite");
        assert.deepStrictEqual(seen, [undefined, 0, false]);
    } finally {
        await server.close();
    }
});

// streams: a body and an answer as a Readable, with the same handler on the Express route

test("stream.pipe(res) answers chunked with the status and the type", async () => {
    await bothWays(
        (app) =>
            app.uwsLite("get", "/s", (req, res) => {
                res.status(202).type("text/csv");
                Readable.from(["a,", "b"]).pipe(res);
            }),
        async (port) => {
            const answer = await call(port, "/s");
            assert.strictEqual(answer.status, 202);
            assert.match(answer.type, /^text\/csv/);
            assert.strictEqual(answer.body, "a,b");
        }
    );
});

test("res.write and res.end, later than the handler too", async () => {
    await bothWays(
        (app) =>
            app.uwsLite("get", "/s", (req, res) => {
                res.write("a");
                setTimeout(() => {
                    res.write("b");
                    res.end("c");
                }, 5);
            }),
        async (port) => assert.strictEqual((await call(port, "/s")).body, "abc")
    );
});

test("a write after a whole answer is refused, and send after a write", async () => {
    const seen = [];
    const server = await serve((app) => {
        app.uwsLite("get", "/whole", (req, res) => {
            res.send("ok");
            assert.throws(() => res.write("x"), /after they are sent/);
            seen.push("whole");
        });
        app.uwsLite("get", "/open", (req, res) => {
            res.write("ok");
            assert.throws(() => res.send("x"), /after they are sent/);
            res.end();
            seen.push("open");
        });
    });
    try {
        assert.strictEqual((await call(server.port, "/whole")).body, "ok");
        assert.strictEqual((await call(server.port, "/open")).body, "ok");
        assert.deepStrictEqual(seen, ["whole", "open"]);
    } finally {
        await server.close();
    }
});

test("a piped answer is compressed by the route when its type is", async () => {
    const text = "hello world ".repeat(1000);
    const server = await serve((app) => {
        app.uwsLite("get", "/s", { compress: {} }, (req, res) => {
            res.type("text/plain");
            Readable.from([text.slice(0, 5000), text.slice(5000)]).pipe(res);
        });
        app.uwsLite("get", "/bin", { compress: {} }, (req, res) => {
            res.type("image/png");
            Readable.from([Buffer.from(text)]).pipe(res);
        });
    });
    try {
        const out = await new Promise((resolve) => {
            http.get({ port: server.port, path: "/s", headers: { "accept-encoding": "gzip" } }, resolve);
        });
        assert.strictEqual(out.headers["content-encoding"], "gzip");
        const chunks = [];
        for await (const chunk of out) {
            chunks.push(chunk);
        }
        assert.strictEqual(zlib.gunzipSync(Buffer.concat(chunks)).toString(), text);
        const bin = await new Promise((resolve) => {
            http.get({ port: server.port, path: "/bin", headers: { "accept-encoding": "gzip" } }, resolve);
        });
        assert.strictEqual(bin.headers["content-encoding"], undefined);
        bin.resume();
    } finally {
        await server.close();
    }
});

test("a big piped answer to a slow reader arrives whole", async () => {
    const chunk = Buffer.alloc(64 * 1024, 97);
    const count = 200;
    const server = await serve((app) => {
        app.uwsLite("get", "/s", (req, res) => {
            function* chunks() {
                for (let i = 0; i < count; i++) {
                    yield chunk;
                }
            }
            Readable.from(chunks()).pipe(res);
        });
    });
    try {
        const out = await new Promise((resolve) => http.get({ port: server.port, path: "/s" }, resolve));
        let total = 0;
        out.pause();
        await wait(50);
        for await (const part of out) {
            total += part.length;
        }
        assert.strictEqual(total, chunk.length * count);
    } finally {
        await server.close();
    }
});

test("a handler that throws after the first write breaks the response", async () => {
    const server = await serve((app) => {
        app.uwsLite("get", "/t", (req, res) => {
            res.write("a");
            throw new Error("x");
        });
    });
    try {
        await assert.rejects(call(server.port, "/t"));
    } finally {
        await server.close();
    }
});

test('body: "stream" is a Readable on both ways, chunked or with a length', async () => {
    await bothWays(
        (app) =>
            app.uwsLite("post", "/s", { body: "stream" }, (req, res) => {
                res.type("text/plain");
                req.body.pipe(res);
            }),
        async (port) => {
            assert.strictEqual((await call(port, "/s", { method: "POST", body: "hello" })).body, "hello");
            const out = await raw(
                port,
                "POST /s HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"
            );
            assert.match(out, /abc[\s\S]*de/);
        }
    );
});

test('body: "stream" holds a big body until the handler reads it', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024, 98);
    let total = 0;
    const server = await serve((app) => {
        app.uwsLite("post", "/s", { body: "stream" }, async (req, res) => {
            await wait(50);
            for await (const chunk of req.body) {
                total += chunk.length;
            }
            res.send("done");
        });
    });
    try {
        assert.strictEqual((await call(server.port, "/s", { method: "POST", body: big })).body, "done");
        assert.strictEqual(total, big.length);
    } finally {
        await server.close();
    }
});

test('a client gone during body: "stream" destroys the body, with an error for who listens', async () => {
    const seen = [];
    const server = await serve((app) => {
        app.uwsLite("post", "/listens", { body: "stream" }, (req) => {
            req.body.on("error", (error) => seen.push(error.code));
            req.body.resume();
        });
        app.uwsLite("post", "/not", { body: "stream" }, (req) => {
            req.body.on("close", () => seen.push("closed"));
            req.body.resume();
        });
    });
    try {
        for (const path of ["/listens", "/not"]) {
            await leave(server.port, `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\nabc`);
        }
        await wait(30);
        assert.deepStrictEqual(seen, ["ECONNRESET", "closed"]);
    } finally {
        await server.close();
    }
});

test("a client gone during a piped answer stops the source and closes without finish", async () => {
    const events = [];
    let destroyed;
    const destroyedSeen = new Promise((resolve) => (destroyed = resolve));
    const server = await serve((app) => {
        app.uwsLite("get", "/s", (req, res) => {
            res.on("finish", () => events.push("finish"));
            res.on("close", () => events.push("close"));
            const source = new Readable({
                read() {
                    this.push(Buffer.alloc(64 * 1024));
                }
            });
            source.on("close", destroyed);
            source.pipe(res);
            res.on("close", () => source.destroy());
        });
    });
    try {
        await leave(server.port, "GET /s HTTP/1.1\r\nHost: x\r\n\r\n");
        await destroyedSeen;
        assert.deepStrictEqual(events, ["close"]);
    } finally {
        await server.close();
    }
});

test("use and stream options are checked at registration", () => {
    const app = express();
    const noop = () => {};
    assert.throws(() => app.uwsLite("get", "/a", { use: noop }, noop), /must be an array/);
    assert.throws(() => app.uwsLite("get", "/a", { use: [1] }, noop), /must be an array/);
    assert.throws(() => app.uwsLite("post", "/a", { use: [noop], body: "lent" }, noop), /no use with body/);
    assert.throws(() => app.uwsLite("post", "/a", { body: "stream", limit: 1 }, noop), /no limit/);
});

test("next() after an answer reaches no handler", async () => {
    let handled = 0;
    const use = [
        (req, res, next) => {
            res.status(403).send("no");
            next();
        }
    ];
    const server = await serve((app) => app.uwsLite("get", "/m", { use }, () => handled++));
    try {
        assert.strictEqual((await call(server.port, "/m")).status, 403);
        assert.strictEqual(handled, 0);
    } finally {
        await server.close();
    }
});

test("a write after the client left does nothing", async () => {
    const seen = [];
    const server = await serve((app) => {
        app.uwsLite("get", "/s", async (req, res) => {
            await wait(60);
            seen.push(res.write("x"));
            res.end();
            seen.push("ended");
        });
    });
    try {
        await leave(server.port, "GET /s HTTP/1.1\r\nHost: x\r\n\r\n");
        await wait(60);
        assert.deepStrictEqual(seen, [false, "ended"]);
    } finally {
        await server.close();
    }
});

test("cork: async middleware that answers asks for one", () => {
    const calls = [];
    const res = {
        cork(write) {
            calls.push("cork");
            write();
        },
        onAborted() {},
        writeHeader() {
            return this;
        },
        end() {
            calls.push("end");
        }
    };
    const req = { getQuery: () => "", getUrl: () => "/", getHeader: () => "", forEach() {} };
    const { makeLiteRoute } = require("../../src/uws-lite.js");
    let later;
    const use = [
        (r, response) => {
            later = response;
        }
    ];
    makeLiteRoute("get", "/", { use }, () => {}).uws(res, req);
    later.send("x");
    assert.deepStrictEqual(calls, ["cork", "end"]);
});

test("res.type does not go through res.set, which lowercases the name on every response", () => {
    const res = { cork: (write) => write(), onAborted() {}, writeHeader: () => res, end() {} };
    const req = { getQuery: () => "", getUrl: () => "/", getHeader: () => "" };
    const { makeLiteRoute } = require("../../src/uws-lite.js");
    let type;
    makeLiteRoute("get", "/", {}, (r, response) => {
        const proto = Object.getPrototypeOf(response);
        const set = proto.set;
        proto.set = () => assert.fail("res.set was called");
        try {
            response.type("text/plain");
            type = response.get("content-type");
        } finally {
            proto.set = set;
        }
        response.end();
    }).uws(res, req);
    assert.strictEqual(type, "text/plain; charset=utf-8");
});

test("use: onAborted once, and not at all for a chain that answered before returning", async () => {
    let armed = 0;
    const res = {
        cork: (write) => write(),
        onAborted() {
            armed++;
        },
        writeHeader() {
            return this;
        },
        end() {}
    };
    const req = { getQuery: () => "", getUrl: () => "/", getHeader: () => "", forEach() {} };
    const { makeLiteRoute } = require("../../src/uws-lite.js");
    const pass = (r, response, next) => next();
    const later = async (r, response, next) => {
        await null;
        next();
    };
    const count = async (use, handler) => {
        armed = 0;
        makeLiteRoute("get", "/", { use }, handler).uws(res, req);
        await new Promise((resolve) => setImmediate(resolve));
        return armed;
    };

    assert.strictEqual(await count([pass], (r, response) => response.send("x")), 0);
    assert.strictEqual(await count([(r, response) => response.send("x")], () => {}), 0);
    assert.strictEqual(await count([pass], () => {}), 1);
    assert.strictEqual(await count([later], () => {}), 1);
    assert.strictEqual(await count([later], (r, response) => response.send("x")), 1);
});

test('body: "stream" pauses µWS when the buffer is full, and only while the response lives', () => {
    const big = new ArrayBuffer(64 * 1024);
    const { makeLiteRoute } = require("../../src/uws-lite.js");
    const req = { getQuery: () => "", getUrl: () => "/", getHeader: () => "" };
    const start = (handler) => {
        const calls = [];
        const res = {
            onAborted() {},
            cork(write) {
                write();
            },
            writeHeader() {
                return this;
            },
            end() {},
            write: () => true,
            onData(feed) {
                res.feed = feed;
            },
            pause: () => calls.push("pause"),
            resume: () => calls.push("resume")
        };
        makeLiteRoute("post", "/", { body: "stream" }, handler).uws(res, req);
        return { res, calls };
    };

    let body;
    const open = start((r) => {
        body = r.body;
    });
    open.res.feed(big, false);
    assert.deepStrictEqual(open.calls, ["pause"]);
    body.read();
    assert.deepStrictEqual(open.calls, ["pause", "resume"]);

    // a whole answer ended res: no µWS call on it after that
    let answered;
    const whole = start((r, res) => {
        answered = [r.body, res];
    });
    whole.res.feed(big, false);
    assert.deepStrictEqual(whole.calls, ["pause"]);
    answered[1].send("x");
    answered[0].read();
    whole.res.feed(big, false);
    assert.deepStrictEqual(whole.calls, ["pause"]);

    // the same when the answer was a stream that is over
    let piped;
    const streamed = start((r, res) => {
        piped = [r.body, res];
    });
    streamed.res.feed(big, false);
    piped[1].write("a");
    piped[1]._bus.out.destroy();
    piped[0].read();
    assert.deepStrictEqual(streamed.calls, ["pause"]);
});

test("each method has its verb, with or without options, and the call with the method stays", async () => {
    const server = await serve((app) => {
        const back = app.uwsLite.get("/verb/:id", (req, res) => res.send(req.params.id));
        assert.strictEqual(back, app);
        app.uwsLite
            .post("/verb", { body: "json" }, (req, res) => res.json(req.body))
            .uwsLite.delete("/verb", (req, res) => res.sendStatus(204))
            .uwsLite.all("/all", (req, res) => res.send(req.method));
        app.uwsLite("get", "/called", (req, res) => res.send("called"));
    });
    try {
        assert.strictEqual((await call(server.port, "/verb/7")).body, "7");
        const posted = await call(server.port, "/verb", { method: "POST", body: '{"a":1}' });
        assert.strictEqual(posted.body, '{"a":1}');
        assert.strictEqual((await call(server.port, "/verb", { method: "DELETE" })).status, 204);
        assert.strictEqual((await call(server.port, "/all", { method: "PUT" })).body, "PUT");
        assert.strictEqual((await call(server.port, "/called")).body, "called");
    } finally {
        await server.close();
    }
});

test("a verb registers the Express route too, for what µWS does not answer", async () => {
    const app = express();
    app.uwsLite.get("/verb", (req, res) => res.send("express"));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    try {
        const answer = await fetch(`http://127.0.0.1:${server.address().port}/verb`);
        assert.strictEqual(await answer.text(), "express");
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

test("compress: true is the defaults, false and nothing are off, on µWS and on the Express route", async () => {
    const big = "x".repeat(5000);
    const routes = (app) => {
        const answer = (req, res) => res.type("txt").send(big);
        app.uwsLite.get("/on", { compress: true }, answer);
        app.uwsLite.get("/off", { compress: false }, answer);
        app.uwsLite.get("/empty", { compress: {} }, answer);
        app.uwsLite.get("/none", answer);
    };
    const encodings = async (port) => {
        const seen = [];
        for (const path of ["/on", "/off", "/empty", "/none"]) {
            const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { "accept-encoding": "gzip" } });
            assert.strictEqual(await res.text(), big);
            seen.push(res.headers.get("content-encoding"));
        }
        return seen;
    };
    const server = await serve(routes);
    try {
        assert.deepStrictEqual(await encodings(server.port), ["gzip", null, "gzip", null]);
    } finally {
        await server.close();
    }
    const app = express();
    routes(app);
    const node = http.createServer(app);
    await new Promise((resolve) => node.listen(0, resolve));
    try {
        assert.deepStrictEqual(await encodings(node.address().port), ["gzip", null, "gzip", null]);
    } finally {
        node.closeAllConnections();
        await new Promise((resolve) => node.close(resolve));
    }
});

test("compress takes a boolean or an object, the rest is refused where it is written", () => {
    const app = express();
    for (const wrong of [null, "gzip", 1]) {
        assert.throws(() => app.uwsLite.get("/x", { compress: wrong }, () => {}), /option compress must be/);
    }
});

test("headers: true keeps all of them, after an await and with a body", async () => {
    const seen = [];
    const server = await serve((app) => {
        app.uwsLite.get("/h", { headers: true }, async (req, res) => {
            await wait(5);
            seen.push(req.get("x-a"), req.get("x-b"), req.headers["x-b"]);
            res.end();
        });
        app.uwsLite.post("/b", { body: "text", headers: true }, (req, res) => res.send(req.get("x-a") + req.body));
        app.uwsLite.get("/n", { headers: false }, async (req, res) => {
            await wait(5);
            try {
                req.get("x-a");
                res.send("read");
            } catch {
                res.send("refused");
            }
        });
    });
    try {
        await call(server.port, "/h", { headers: { "x-a": "1", "x-b": "2" } });
        assert.deepStrictEqual(seen, ["1", "2", "2"]);
        const posted = await call(server.port, "/b", { method: "POST", headers: { "x-a": "1" }, body: "z" });
        assert.strictEqual(posted.body, "1z");
        assert.strictEqual((await call(server.port, "/n", { headers: { "x-a": "1" } })).body, "refused");
    } finally {
        await server.close();
    }
});

test("headers takes names, true or false, the rest is refused where it is written", () => {
    const app = express();
    for (const wrong of [null, "x-a", 1]) {
        assert.throws(() => app.uwsLite.get("/x", { headers: wrong }, () => {}), /option headers must be/);
    }
});

test("the headers kept for one request are not those of the next one", async () => {
    const server = await serve((app) => {
        app.uwsLite.get("/h", { headers: true }, async (req, res) => {
            await wait(40);
            res.send(`${req.get("x-a")} ${req.get("x-b")}`);
        });
    });
    try {
        const first = call(server.port, "/h", { headers: { "x-a": "1", "x-b": "2" } });
        await wait(10);
        const second = call(server.port, "/h", { headers: { "x-a": "3" } });
        assert.strictEqual((await first).body, "1 2");
        assert.strictEqual((await second).body, "3 undefined");
    } finally {
        await server.close();
    }
});

test("req.headers is one object, what middleware writes on it is there for the handler", async () => {
    const add = async (req, res, next) => {
        await wait(5);
        req.headers["x-user"] = "ann";
        next();
    };
    const server = await serve((app) => {
        app.uwsLite.get("/h", { use: [add] }, async (req, res) => {
            await wait(5);
            res.send(`${req.headers["x-user"]} ${req.get("x-user")}`);
        });
    });
    try {
        assert.strictEqual((await call(server.port, "/h")).body, "ann ann");
    } finally {
        await server.close();
    }
});
