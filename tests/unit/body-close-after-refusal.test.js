// A body refused for its size is not read on: the connection closes once the answer is out. Express
// reads the rest and keeps the connection (docs/differences.md), which thousands of clients each
// sending gigabytes turn into the kernel's receive buffers filling faster than anything drains
// them, the resilience suite's large-upload and hashdos. What these pin: the answer still arrives
// whole, with one Connection: close and no Keep-Alive, the server hangs up, and a body that fits
// keeps the connection as before.

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

/**
 * Writes the request, then keeps writing `trailing` bytes of body until the server hangs up or
 * two seconds pass, and reports what came back and whether the server closed the connection.
 */
function exchange(port, head, body, trailing = 0) {
    return new Promise((resolve, reject) => {
        let data = "";
        let closedByServer = false;
        const socket = net.connect(port, "127.0.0.1", () => {
            socket.write(head);
            if (body) socket.write(body);
            let left = trailing;
            const pump = () => {
                while (left > 0 && !socket.destroyed) {
                    const n = Math.min(left, 64 * 1024);
                    left -= n;
                    if (!socket.write(Buffer.alloc(n, "a"))) return socket.once("drain", pump);
                }
            };
            pump();
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

test("a declared length over the limit: 413 at once, then the server hangs up", async () => {
    const { port, close } = await serve((app) => {
        app.post("/", express.raw({ type: () => true, limit: "1kb" }), (req, res) => res.send("ok"));
        app.use(errorHandler);
    });
    try {
        const answer = await exchange(
            port,
            "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: 1073741824\r\n\r\n",
            null,
            4 * 1024 * 1024
        );
        assert.strictEqual(answer.status, 413);
        assert.strictEqual(answer.body, "entity.too.large");
        assert.deepStrictEqual(answer.connection, ["connection: close"]);
        assert.strictEqual(answer.keepAlive, false);
        assert.strictEqual(answer.closedByServer, true);
    } finally {
        close();
    }
});

test("a chunked body found over the limit while reading: the same", async () => {
    const { port, close } = await serve((app) => {
        app.post("/", express.json({ limit: 20 }), (req, res) => res.send("ok"));
        app.use(errorHandler);
    });
    try {
        const chunk = JSON.stringify({ padding: "x".repeat(100) });
        const answer = await exchange(
            port,
            "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
            chunk.length.toString(16) + "\r\n" + chunk + "\r\n0\r\n\r\n"
        );
        assert.strictEqual(answer.status, 413);
        assert.deepStrictEqual(answer.connection, ["connection: close"]);
        assert.strictEqual(answer.closedByServer, true);
    } finally {
        close();
    }
});

test("a compressed body inflating past the limit: the same", async () => {
    const { port, close } = await serve((app) => {
        app.post("/", express.raw({ type: () => true }), (req, res) => res.send("ok"));
        app.use(errorHandler);
    });
    try {
        const bomb = zlib.gzipSync(Buffer.alloc(16 * 1024 * 1024));
        const answer = await exchange(
            port,
            "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Encoding: gzip\r\n" +
                `Content-Length: ${bomb.length}\r\n\r\n`,
            bomb
        );
        assert.strictEqual(answer.status, 413);
        assert.deepStrictEqual(answer.connection, ["connection: close"]);
        assert.strictEqual(answer.closedByServer, true);
    } finally {
        close();
    }
});

test("an error handler answering something else still closes, with one Connection header", async () => {
    const { port, close } = await serve((app) => {
        app.set("connection headers", false);
        app.post("/", express.json({ limit: 20 }), (req, res) => res.send("ok"));
        app.use((err, req, res, next) => res.status(200).send("handled " + err.type));
    });
    try {
        const body = JSON.stringify({ padding: "x".repeat(100) });
        const answer = await exchange(
            port,
            `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
            body
        );
        assert.strictEqual(answer.status, 200);
        assert.strictEqual(answer.body, "handled entity.too.large");
        assert.deepStrictEqual(answer.connection, ["connection: close"]);
        assert.strictEqual(answer.closedByServer, true);
    } finally {
        close();
    }
});

test("a body under the limit keeps the connection", async () => {
    const { port, close } = await serve((app) => {
        app.post("/", express.json({ limit: 1000 }), (req, res) => res.send("ok"));
        app.use(errorHandler);
    });
    try {
        const body = JSON.stringify({ a: 1 });
        const answer = await exchange(
            port,
            `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
            body
        );
        assert.strictEqual(answer.status, 200);
        assert.deepStrictEqual(answer.connection, ["connection: keep-alive"]);
        assert.strictEqual(answer.closedByServer, false);
    } finally {
        close();
    }
});
