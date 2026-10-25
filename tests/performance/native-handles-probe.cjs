"use strict";

const { fork } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const mode = process.argv[2];

if (mode) process.on("disconnect", () => process.exit(1));

if (mode === "server") {
    const v8 = require("node:v8");
    const uWS = require(process.argv[3]);
    const count = Number(process.argv[4]);
    let received = 0;
    let aborted = 0;
    const snapshot = (type) => {
        setImmediate(() => {
            global.gc();
            global.gc();
            const used = v8.getHeapStatistics().used_global_handles_size;
            process.send({ type, used, received, aborted });
        });
    };
    const onAbort = () => {
        if (++aborted === count) snapshot("released");
        if (aborted > count) throw new Error("unexpected abort callback");
    };
    const app = uWS.App();
    app.get("/warm", (res) => res.end("ok"));
    app.get("/pending", (res) => {
        res.onAborted(onAbort);
        if (++received === count) snapshot("pending");
        if (received > count) throw new Error("unexpected request");
    });
    process.on("message", (msg) => {
        if (msg.type === "baseline") snapshot("baseline");
    });
    app.listen("127.0.0.1", 0, (socket) => {
        if (!socket) throw new Error("listen failed");
        process.send({ type: "ready", port: uWS.us_socket_local_port(socket) });
    });
} else if (mode === "client") {
    const http = require("node:http");
    const port = Number(process.argv[3]);
    const count = Number(process.argv[4]);
    const keep = [];
    const options = { host: "127.0.0.1", port, agent: false };
    let closing = false;
    process.on("message", (msg) => {
        if (msg.type === "start") {
            for (let i = 0; i < count; i++) {
                const request = http.get({ ...options, path: "/pending" }, () => {
                    throw new Error("pending response ended early");
                });
                request.on("error", (err) => {
                    if (!closing) throw err;
                });
                keep.push(request);
            }
        } else if (msg.type === "close") {
            closing = true;
            for (const request of keep) request.destroy();
        }
    });
    http.get({ ...options, path: "/warm" }, (res) => {
        if (res.statusCode !== 200) throw new Error("warmup failed");
        res.resume();
        res.on("end", () => process.send({ type: "ready" }));
    }).on("error", (err) => {
        throw err;
    });
} else {
    const wait = (child, type) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error(`timeout waiting for ${type}`)), 10000);
            const onExit = (code, signal) => finish(new Error(`child exited ${code}/${signal} waiting for ${type}`));
            const onMessage = (msg) => {
                if (msg.type === type) finish(null, msg);
            };
            function finish(error, value) {
                clearTimeout(timer);
                child.off("message", onMessage);
                child.off("exit", onExit);
                child.off("error", finish);
                error ? reject(error) : resolve(value);
            }
            child.on("message", onMessage);
            child.on("exit", onExit);
            child.on("error", finish);
            if (child.exitCode !== null || child.signalCode !== null) onExit(child.exitCode, child.signalCode);
        });
    const stop = (child) =>
        new Promise((resolve) => {
            if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
            const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
            child.kill("SIGTERM");
        });
    const start = (args, execArgv) =>
        fork(__filename, args, {
            execArgv,
            stdio: ["ignore", "ignore", "inherit", "ipc"]
        });
    const count = 128;
    const entry = process.env.FULMINE_PERF_UWS
        ? require.resolve(path.resolve(process.env.FULMINE_PERF_UWS))
        : require.resolve("uWebSockets.js");
    let source = null;
    try {
        source = fs.readFileSync(path.join(path.dirname(entry), "source_commit"), "utf8").trim();
    } catch {
        // A repackaged binary can lack the marker; its handle cost is still measured.
    }
    async function measure() {
        const server = start(["server", entry, String(count)], ["--expose-gc"]);
        let client;
        try {
            const { port } = await wait(server, "ready");
            client = start(["client", String(port), String(count)], []);
            await wait(client, "ready");
            let next = wait(server, "baseline");
            server.send({ type: "baseline" });
            const baseline = await next;
            next = wait(server, "pending");
            client.send({ type: "start" });
            const pending = await next;
            next = wait(server, "released");
            client.send({ type: "close" });
            const released = await next;
            return {
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                entry,
                source,
                count,
                baseline,
                pending,
                released
            };
        } finally {
            await stop(client);
            await stop(server);
        }
    }
    measure()
        .then((report) => console.log(JSON.stringify(report)))
        .catch((err) => {
            console.error(err);
            process.exitCode = 1;
        });
}
