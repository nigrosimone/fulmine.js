// A body refused for its size with more than 256 KB left: the answer arrives with one Connection: close,
// then the server hangs up. With less left, or a body that fits, the connection stays as on Express.

const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const zlib = require("node:zlib");

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

/** Writes the request, waits until the server hangs up or two seconds pass, and reports what came back. */
function exchange(port, head, body) {
    return new Promise((resolve, reject) => {
        let data = "";
        let closedByServer = false;
        const socket = net.connect(port, "127.0.0.1", () => {
            socket.write(head);
            if (body) socket.write(body);
        });
        socket.on("data", (chunk) => (data += chunk));
        socket.on("end", () => (closedByServer = true));
        // writing into a socket the server reset is the server closing too
        socket.on("error", (err) => {
            if (err.code === "ECONNRESET" || err.code === "EPIPE") closedByServer = true;
            else reject(err);
        });
        const done = () => {
            const [headText = "", ...rest] = data.split("\r\n\r\n");
            const lines = headText.split("\r\n").map((line) => line.toLowerCase());
            resolve({
                status: Number((headText.match(/^HTTP\/1\.1 (\d+)/) || [])[1]),
                connection: lines.filter((line) => line.startsWith("connection:")),
                keepAlive: lines.some((line) => line.startsWith("keep-alive:")),
                body: rest.join("\r\n\r\n"),
                closedByServer
            });
        };
        socket.on("close", done);
        setTimeout(() => {
            socket.destroy();
        }, 2000).unref();
    });
}

const errorHandler = (err, req, res, next) => res.status(err.status || 500).send(err.type || "error");

/** One request against an app with the error handler above. */
async function refuse(setup, head, body) {
    const { port, close } = await serve((app) => {
        setup(app);
        app.use(errorHandler);
    });
    try {
        return await exchange(port, head, body);
    } finally {
        close();
    }
}

test("a declared length over the limit with more than 256 KB left: 413, then the server hangs up", async () => {
    // only the head is sent: a client still writing gets a reset, see docs/differences.md
    const answer = await refuse(
        (app) => app.post("/", express.raw({ type: () => true, limit: "1kb" }), (req, res) => res.send("ok")),
        "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: 1073741824\r\n\r\n",
        null
    );
    assert.strictEqual(answer.status, 413);
    assert.strictEqual(answer.body, "entity.too.large");
    assert.deepStrictEqual(answer.connection, ["connection: close"]);
    assert.strictEqual(answer.keepAlive, false);
    assert.strictEqual(answer.closedByServer, true);
});

test("a declared length over the limit with 256 KB or less left: 413 and the connection stays", async () => {
    const body = Buffer.alloc(200 * 1024, "a");
    const answer = await refuse(
        (app) => app.post("/", express.raw({ type: () => true, limit: "100kb" }), (req, res) => res.send("ok")),
        `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\n\r\n`,
        body
    );
    assert.strictEqual(answer.status, 413);
    assert.deepStrictEqual(answer.connection, ["connection: keep-alive"]);
    assert.strictEqual(answer.closedByServer, false);
});

test("a chunked body over the limit, the rest unknown: 413, then the server hangs up", async () => {
    const chunk = JSON.stringify({ padding: "x".repeat(100) });
    const answer = await refuse(
        (app) => app.post("/", express.json({ limit: 20 }), (req, res) => res.send("ok")),
        "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
        chunk.length.toString(16) + "\r\n" + chunk + "\r\n0\r\n\r\n"
    );
    assert.strictEqual(answer.status, 413);
    assert.deepStrictEqual(answer.connection, ["connection: close"]);
    assert.strictEqual(answer.closedByServer, true);
});

test("a compressed body inflating past the limit, a small content-length: 413 and the connection stays", async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(16 * 1024 * 1024));
    const answer = await refuse(
        (app) => app.post("/", express.raw({ type: () => true }), (req, res) => res.send("ok")),
        "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Encoding: gzip\r\n" +
            `Content-Length: ${bomb.length}\r\n\r\n`,
        bomb
    );
    assert.strictEqual(answer.status, 413);
    assert.deepStrictEqual(answer.connection, ["connection: keep-alive"]);
    assert.strictEqual(answer.closedByServer, false);
});

test("an error handler answering something else still closes, with one Connection header", async () => {
    const answer = await refuse(
        (app) => {
            app.set("connection headers", false);
            app.post("/", express.json({ limit: 20 }), (req, res) => res.send("ok"));
            app.use((err, req, res, next) => res.status(200).send("handled " + err.type));
        },
        "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1048576\r\n\r\n",
        null
    );
    assert.strictEqual(answer.status, 200);
    assert.strictEqual(answer.body, "handled entity.too.large");
    assert.deepStrictEqual(answer.connection, ["connection: close"]);
    assert.strictEqual(answer.closedByServer, true);
});

test("a body under the limit keeps the connection", async () => {
    const body = JSON.stringify({ a: 1 });
    const answer = await refuse(
        (app) => app.post("/", express.json({ limit: 1000 }), (req, res) => res.send("ok")),
        `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
        body
    );
    assert.strictEqual(answer.status, 200);
    assert.deepStrictEqual(answer.connection, ["connection: keep-alive"]);
    assert.strictEqual(answer.closedByServer, false);
});

for (const body of ["buffer", "lent", "text"]) {
    test(`app.uwsLite with body "${body}": a length over the limit gets 413, then the server hangs up`, async () => {
        const answer = await refuse(
            (app) => app.uwsLite.post("/", { body, limit: "1kb" }, (req, res) => res.send("ok")),
            "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: 1073741824\r\n\r\n",
            // µWS refuses once the bytes read pass the limit, not on the declared length
            "a".repeat(4096)
        );
        assert.strictEqual(answer.status, 413);
        assert.strictEqual(answer.body, "Payload Too Large");
        assert.deepStrictEqual(answer.connection, ["connection: close"]);
        assert.strictEqual(answer.closedByServer, true);
    });
}

test("app.uwsLite: a declared length over the limit is refused before any byte of the body", async () => {
    const answer = await refuse(
        (app) => app.uwsLite.post("/", { body: "lent", limit: "1kb" }, (req, res) => res.send("ok")),
        "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1073741824\r\n\r\n",
        null
    );
    assert.strictEqual(answer.status, 413);
    assert.strictEqual(answer.body, "Payload Too Large");
    assert.deepStrictEqual(answer.connection, ["connection: close"]);
    assert.strictEqual(answer.closedByServer, true);
});

test("app.uwsLite: a chunked body over the limit gets 413, then the server hangs up", async () => {
    const answer = await refuse(
        (app) => app.uwsLite.post("/", { body: "buffer", limit: "1kb" }, (req, res) => res.send("ok")),
        "POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n",
        "800\r\n" + "a".repeat(2048) + "\r\n"
    );
    assert.strictEqual(answer.status, 413);
    assert.deepStrictEqual(answer.connection, ["connection: close"]);
    assert.strictEqual(answer.closedByServer, true);
});

test("express.uwsUtils.readBuffer: a body over the limit gets 413, then the server hangs up", async () => {
    const answer = await refuse(
        (app) =>
            app.uws.post("/", (res) => {
                express.uwsUtils.readBuffer(res, () => express.uwsUtils.send(res, 200, null, "ok"), { limit: "1kb" });
            }),
        "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 1073741824\r\n\r\n",
        "a".repeat(4096)
    );
    assert.strictEqual(answer.status, 413);
    assert.deepStrictEqual(answer.connection, ["connection: close"]);
    assert.strictEqual(answer.closedByServer, true);
});
