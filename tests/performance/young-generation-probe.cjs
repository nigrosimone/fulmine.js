"use strict";

// The young generation of a server after concurrent keep-alive load: V8 grows it when objects
// survive the scavenges, which a closure kept per response did. Prints the server's largest
// new space in bytes.
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const mode = process.argv[2];

if (mode === "server") {
    process.on("disconnect", () => process.exit(1));
    const v8 = require("node:v8");
    const express = require(path.join(process.argv[3], "index.js"));
    let largest = 0;
    setInterval(() => {
        for (const space of v8.getHeapSpaceStatistics()) {
            if (space.space_name === "new_space") largest = Math.max(largest, space.physical_space_size);
        }
    }, 20);
    // the arena's json route, asked without Accept-Encoding as its TLS profile asks it
    const app = express();
    const dataset = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `Item ${i}`, tags: ["a", "b"] }));
    app.get("/json/:count", express.compression(), (req, res) => {
        const count = Math.min(parseInt(req.params.count, 10) || 0, dataset.length);
        res.json({ items: dataset.slice(0, count).map((d) => ({ ...d })), count });
    });
    const server = app.listen(0, "127.0.0.1", () => process.send({ type: "ready", port: server.address().port }));
    process.on("message", (msg) => {
        if (msg.type === "report") process.send({ type: "report", largest });
    });
} else {
    const source = path.resolve(process.env.FULMINE_PERF_SOURCE || path.join(__dirname, "../../src"));
    const sockets = 128;
    const perSocket = 400;
    const server = fork(__filename, ["server", source], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const next = (type) => new Promise((resolve) => server.on("message", (msg) => msg.type === type && resolve(msg)));
    /**
     * Asks again as soon as the whole answer is in, perSocket times.
     * @param {number} port
     * @returns {Promise<void>}
     */
    const run = (port) =>
        new Promise((resolve, reject) => {
            const raw = Buffer.from("GET /json/10 HTTP/1.1\r\nHost: localhost\r\n\r\n");
            let left = perSocket;
            let received = Buffer.alloc(0);
            const socket = net.connect(port, "127.0.0.1", () => socket.write(raw));
            socket.on("data", (chunk) => {
                received = received.length ? Buffer.concat([received, chunk]) : chunk;
                for (;;) {
                    const end = received.indexOf("\r\n\r\n");
                    if (end === -1) return;
                    const head = received.toString("latin1", 0, end).toLowerCase();
                    const length = /\r\ncontent-length: *(\d+)/.exec(head);
                    assert.ok(length, `no content-length: ${head}`);
                    const size = end + 4 + Number(length[1]);
                    if (received.length < size) return;
                    received = received.subarray(size);
                    if (--left === 0) {
                        socket.end();
                        return resolve();
                    }
                    socket.write(raw);
                }
            });
            socket.on("error", reject);
        });
    (async () => {
        try {
            const { port } = await next("ready");
            await Promise.all(Array.from({ length: sockets }, () => run(port)));
            const report = next("report");
            server.send({ type: "report" });
            const { largest } = await report;
            console.log(JSON.stringify({ largest }));
        } finally {
            server.kill("SIGKILL");
        }
    })().catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}
