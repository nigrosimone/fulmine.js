// The request subscribes to the uWS body only once the synchronous dispatch is over, and only when
// no parser collected it natively on the way, see Request._settleBody. What these pin is what a
// client sees when nothing collected it synchronously: a parser reached after an await, a handler
// reading the stream late, and a body nobody reads, which must still be drained so the next
// request on the connection is answered.

const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");

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

/** Writes raw requests on one connection and parses `count` responses by their content-length. */
function exchange(port, raw, count) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => socket.write(raw));
        let data = "";
        const responses = [];
        socket.on("data", (chunk) => {
            data += chunk;
            for (;;) {
                const headEnd = data.indexOf("\r\n\r\n");
                if (headEnd === -1) {
                    return;
                }
                const head = data.slice(0, headEnd);
                const length = Number((head.match(/content-length: (\d+)/i) || [])[1]);
                if (data.length < headEnd + 4 + length) {
                    return;
                }
                responses.push({
                    status: Number((head.match(/^HTTP\/1\.1 (\d+)/) || [])[1]),
                    body: data.slice(headEnd + 4, headEnd + 4 + length)
                });
                data = data.slice(headEnd + 4 + length);
                if (responses.length === count) {
                    socket.end();
                    resolve(responses);
                    return;
                }
            }
        });
        socket.on("error", reject);
    });
}

function post(path, body) {
    return `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a parser reached after an await still gets the body", async () => {
    const { port, close } = await serve((app) => {
        app.use(async (req, res, next) => {
            await sleep(20);
            next();
        });
        app.post("/echo", express.json(), (req, res) => res.json(req.body));
    });
    const [echo] = await exchange(port, post("/echo", '{"a":1}'), 1);
    assert.strictEqual(echo.status, 200);
    assert.strictEqual(echo.body, '{"a":1}');
    close();
});

test("a handler reading the stream after an await gets the body", async () => {
    const { port, close } = await serve((app) => {
        app.post("/late", async (req, res) => {
            await sleep(20);
            let data = "";
            req.on("data", (chunk) => (data += chunk));
            req.on("end", () => res.send(data));
        });
    });
    const [late] = await exchange(port, post("/late", "late body"), 1);
    assert.strictEqual(late.status, 200);
    assert.strictEqual(late.body, "late body");
    close();
});

test("a body nobody reads is drained, the next request on the connection is answered", async () => {
    const { port, close } = await serve((app) => {
        app.post("/ignore", (req, res) => res.send("ignored"));
        app.post("/small", express.json({ limit: 4 }), (req, res) => res.json(req.body));
        app.get("/ok", (req, res) => res.send("ok"));
    });
    const [ignored, afterIgnored] = await exchange(
        port,
        post("/ignore", "x".repeat(40)) + "GET /ok HTTP/1.1\r\nHost: x\r\n\r\n",
        2
    );
    assert.strictEqual(ignored.body, "ignored");
    assert.strictEqual(afterIgnored.body, "ok");
    const [refused, afterRefused] = await exchange(
        port,
        post("/small", '{"a":"too long"}') + "GET /ok HTTP/1.1\r\nHost: x\r\n\r\n",
        2
    );
    assert.strictEqual(refused.status, 413);
    assert.strictEqual(afterRefused.body, "ok");
    close();
});

test("a parser streaming an encoded body keeps its own uWS handler", async () => {
    const { port, close } = await serve((app) => {
        app.post("/echo", express.json(), (req, res) => res.json(req.body));
    });
    const body = require("node:zlib").deflateSync('{"a":1}');
    const raw = Buffer.concat([
        Buffer.from(
            `POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Encoding: deflate\r\nContent-Length: ${body.length}\r\n\r\n`
        ),
        body
    ]);
    const [echo] = await exchange(port, raw, 1);
    assert.strictEqual(echo.status, 200);
    assert.strictEqual(echo.body, '{"a":1}');
    close();
});
