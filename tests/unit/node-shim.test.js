// The node:http shim, exercised the way its consumers reach it: http.createServer(app) and the
// callable app. This is the compatibility path supertest and vhost ride, and its address, body
// and streaming plumbing had the least coverage of any file in src.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");

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
