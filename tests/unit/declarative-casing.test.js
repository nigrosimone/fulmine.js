// A compiled route writes its headers as the compiler laid them down at listen(), so the names
// have to be lowercased there the way setHeader stores them, or the two paths answer different
// bytes for the same handler, see issue #7. Read raw off the socket, since fetch() folds case.

const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");

const express = require("../../src/index.js");

function rawGet(port, path) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
            socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
        });
        let data = "";
        socket.on("data", (chunk) => (data += chunk));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
    });
}

test("a compiled route answers header names lowercased, as the ordinary path does", async () => {
    const app = express();
    // etag off is what lets a route with a body compile at all, see declarative.js
    app.set("etag", false);
    app.get("/c", (req, res) => {
        res.set("X-Custom", "v");
        res.send("ok");
    });
    await new Promise((resolve) => app.listen(0, resolve));

    try {
        const raw = await rawGet(app.address().port, "/c");
        assert.ok(raw.includes("x-custom: v"), `expected a lowercased name on the wire:\n${raw}`);
        assert.ok(!raw.includes("X-Custom"), `the author's casing must not reach the wire:\n${raw}`);
    } finally {
        app.close();
    }
});
