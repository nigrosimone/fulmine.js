// The node:http shim, exercised the way its consumers reach it: http.createServer(app) and the
// callable app. This is the compatibility path supertest and vhost ride, and its address, body
// and streaming plumbing had the least coverage of any file in src.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const express = require("../../src/index.js");

/**
 * Starts a node http server for the given listener and answers fetch helpers bound to it.
 *
 * @param {any} listener
 * @param {string} [host] the address to bind, 127.0.0.1 unless the test needs another
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
function serve(listener, host = "127.0.0.1") {
    return new Promise((resolve) => {
        const server = http.createServer(listener);
        server.listen(0, host, () => {
            const address = /** @type {any} */ (server.address());
            const shownHost = host.includes(":") ? `[${host}]` : host;
            resolve({
                url: `http://${shownHost}:${address.port}`,
                close: () => new Promise((done) => server.close(() => done()))
            });
        });
    });
}

test("a GET through the shim answers with the body and sees the client address", async () => {
    const app = express();
    let seenIp;
    app.get("/hello", (req, res) => {
        seenIp = req.ip;
        res.send("hello from the shim");
    });

    const { url, close } = await serve(app);
    const res = await fetch(`${url}/hello`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "hello from the shim");
    // node reports the v4 loopback plainly or v6-mapped depending on the socket
    assert.match(String(seenIp), /^(::ffff:)?127\.0\.0\.1$/);
    await close();
});

test("an IPv6 client address survives the byte round trip", async () => {
    const app = express();
    let seenIp;
    app.get("/v6", (req, res) => {
        seenIp = req.ip;
        res.send("ok");
    });

    let served;
    try {
        served = await serve(app, "::1");
    } catch {
        // machines without a v6 loopback skip rather than fail
        return;
    }
    const res = await fetch(`${served.url}/v6`);
    assert.equal(res.status, 200);
    assert.equal(seenIp, "::1");
    await served.close();
});

test("a JSON body arrives whole through the shim's data plumbing", async () => {
    const app = express();
    app.use(express.json());
    app.post("/echo", (req, res) => {
        res.json(req.body);
    });

    const { url, close } = await serve(app);
    const payload = { hello: "world", n: 42, deep: { a: [1, 2, 3] } };
    const res = await fetch(`${url}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), payload);
    await close();
});

test("a HEAD answers the GET's headers and no body", async () => {
    const app = express();
    app.get("/sized", (req, res) => {
        res.send("twelve bytes");
    });

    const { url, close } = await serve(app);
    const res = await fetch(`${url}/sized`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), "12");
    assert.equal(await res.text(), "");
    await close();
});

test("sendFile streams a real file through the shim", async () => {
    const app = express();
    app.get("/file", (req, res) => {
        res.sendFile(path.join(__dirname, "..", "..", "package.json"));
    });

    const { url, close } = await serve(app);
    const res = await fetch(`${url}/file`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.name, "fulmine.js");
    await close();
});

test("repeated headers reach the request joined, not last-one-wins", async () => {
    const app = express();
    let seen;
    app.get("/dup", (req, res) => {
        seen = req.get("x-dup");
        res.send("ok");
    });

    const { url, close } = await serve(app);
    await fetch(`${url}/dup`, {
        headers: [
            ["x-dup", "one"],
            ["x-dup", "two"]
        ]
    });
    assert.match(String(seen), /one/);
    assert.match(String(seen), /two/);
    await close();
});

test("a chunked response goes out through the shim's write path", async () => {
    const app = express();
    app.get("/chunks", (req, res) => {
        res.type("text/plain");
        res.write("first ");
        res.write("second ");
        res.end("third");
    });

    const { url, close } = await serve(app);
    const res = await fetch(`${url}/chunks`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "first second third");
    await close();
});

test("a body far past the stream's buffer arrives whole, pausing and resuming underneath", async () => {
    const app = express();
    // raw() streams the body through the request Readable, whose 128 KB high-water mark is
    // what makes the shim's pause() and resume() actually run under a 5 MB body
    app.use(express.raw({ type: "application/octet-stream", limit: "10mb" }));
    app.post("/big", (req, res) => {
        res.json({ length: req.body.length, first: req.body[0], last: req.body[req.body.length - 1] });
    });

    const { url, close } = await serve(app);
    const payload = Buffer.alloc(5 * 1024 * 1024, 7);
    payload[payload.length - 1] = 9;
    const res = await fetch(`${url}/big`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: payload
    });
    assert.deepEqual(await res.json(), { length: payload.length, first: 7, last: 9 });
    await close();
});

test("a handler consuming the body as a slow stream drives the shim's pause and resume", async () => {
    const app = express();
    app.post("/slurp", (req, res) => {
        let total = 0;
        req.on("data", (chunk) => {
            total += chunk.length;
            // a consumer slower than the wire, which is what backpressure exists for
            req.pause();
            setTimeout(() => req.resume(), 1);
        });
        req.on("end", () => res.json({ total }));
    });

    const { url, close } = await serve(app);
    const payload = Buffer.alloc(2 * 1024 * 1024, 3);
    const res = await fetch(`${url}/slurp`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: payload
    });
    assert.deepEqual(await res.json(), { total: payload.length });
    await close();
});

test("a file past the cache cutoff streams through the shim's sized write path", async () => {
    // over sendFile's 768 KB small-file line, so the streamed branch runs rather than the cache
    const file = path.join(os.tmpdir(), `fulmine-shim-test-${process.pid}.bin`);
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 5));
    const app = express();
    app.get("/big-file", (req, res) => {
        res.sendFile(file);
    });

    const { url, close } = await serve(app);
    try {
        const res = await fetch(`${url}/big-file`);
        assert.equal(res.status, 200);
        const body = await res.arrayBuffer();
        assert.equal(body.byteLength, 1024 * 1024 + 1);
        assert.equal(new Uint8Array(body)[1024 * 1024], 5);
    } finally {
        await close();
        fs.unlinkSync(file);
    }
});

test("the socket the shim shows carries the client's port and address", async () => {
    const app = express();
    let seen;
    app.get("/sock", (req, res) => {
        seen = { port: req.socket.remotePort, address: req.socket.remoteAddress };
        res.send("ok");
    });

    const { url, close } = await serve(app);
    await fetch(`${url}/sock`);
    assert.ok(Number.isInteger(seen.port) && seen.port > 0, String(seen.port));
    assert.match(String(seen.address), /127\.0\.0\.1|::1/);
    await close();
});

test("a client vanishing mid-response reaches the shim's abort path without wounding the server", async () => {
    const app = express();
    let sawClose = false;
    app.get("/slow", (req, res) => {
        res.on("close", () => {
            sawClose = true;
        });
        res.type("text/plain");
        res.write("started ");
        // the rest never goes out: the client is about to hang up
    });
    app.get("/after", (req, res) => res.send("still alive"));

    const { url, close } = await serve(app);
    await new Promise((resolve) => {
        const request = http.get(`${url}/slow`, (res) => {
            res.once("data", () => {
                request.destroy();
                resolve();
            });
        });
        request.on("error", resolve);
    });
    // the server must still answer new requests afterwards
    for (let waited = 0; waited < 2000 && !sawClose; waited += 50) {
        await new Promise((r) => setTimeout(r, 50));
    }
    const after = await fetch(`${url}/after`);
    assert.equal(await after.text(), "still alive");
    await close();
});

test("the callable app hands an unmatched request to its next callback", async () => {
    const app = express();
    app.get("/known", (req, res) => res.send("known"));

    const { url, close } = await serve((req, res) => {
        app(req, res, () => {
            res.statusCode = 404;
            res.end("the outer server's own answer");
        });
    });

    const hit = await fetch(`${url}/known`);
    assert.equal(await hit.text(), "known");
    const miss = await fetch(`${url}/unknown`);
    assert.equal(miss.status, 404);
    assert.equal(await miss.text(), "the outer server's own answer");
    await close();
});
