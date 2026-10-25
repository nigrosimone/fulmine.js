"use strict";

// Heap per request on a real server: a client process asks one route over one keep-alive socket,
// and the server reads heapUsed every `count` requests at the entry of the µWS handler.
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const mode = process.argv[2];

if (mode) process.on("disconnect", () => process.exit(1));

if (mode === "server") {
    const { performance, PerformanceObserver } = require("node:perf_hooks");
    const source = process.argv[3];
    assert.equal(typeof global.gc, "function");
    // wrapped before fulmine loads it, as in tests/unit/native-census.app.js
    const uWS = require(require.resolve("uWebSockets.js", { paths: [source] }));
    let plan = null;
    let seen = 0;
    let before = 0;
    let start = 0;
    let events = [];
    const samples = [];
    const observer = new PerformanceObserver((list) => {
        events.push(...list.getEntries());
    });
    observer.observe({ entryTypes: ["gc"] });
    const collect = () => {
        global.gc();
        global.gc();
    };
    function mark() {
        if (!plan || ++seen <= plan.warmup || (seen - plan.warmup - 1) % plan.count !== 0) return;
        if (samples.length < plan.rounds && seen > plan.warmup + 1) {
            const allocated = process.memoryUsage().heapUsed - before;
            const finish = performance.now();
            const during = events.filter((event) => event.startTime >= start && event.startTime < finish).length;
            collect();
            const retained = process.memoryUsage().heapUsed - before;
            samples.push({ allocated: allocated / plan.count, retained: retained / plan.count, gc: during });
            if (samples.length === plan.rounds) {
                setImmediate(() => process.send({ type: "samples", samples: samples.splice(0) }));
                plan = null;
                return;
            }
        }
        collect();
        events = [];
        start = performance.now();
        before = process.memoryUsage().heapUsed;
    }
    const App = uWS.App;
    uWS.App = function (...args) {
        const app = App.apply(this, args);
        for (const method of ["get", "post", "put", "del", "patch", "head", "options", "any"]) {
            const register = app[method];
            app[method] = function (pattern, handler) {
                if (typeof handler === "function") {
                    const inner = handler;
                    handler = (res, req) => {
                        mark();
                        return inner(res, req);
                    };
                }
                return register.call(this, pattern, handler);
            };
        }
        return app;
    };
    const express = require(path.join(source, "index.js"));
    const zlib = require("node:zlib");

    // the shapes an Express app has, on the default settings
    const app = express();
    app.get("/hello", (req, res) => res.send("hello"));
    app.get("/json", (req, res) => res.json({ id: 1, name: "fulmine", tags: ["a", "b"] }));
    app.get("/users/:id", (req, res) => res.json({ id: req.params.id, q: req.query.q }));
    app.get("/ua", (req, res) => res.send(req.get("user-agent")));
    app.use("/mw", (req, res, next) => next());
    app.get("/mw/x", (req, res) => res.send("mw"));
    const router = express.Router();
    router.get("/x", (req, res) => res.send("routed"));
    app.use("/r", router);
    app.post("/echo", express.json(), (req, res) => res.json(req.body));

    // the routes of the HttpArena entry, with its settings
    const arena = express();
    arena.disable("x-powered-by");
    arena.set("etag", false);
    arena.set("connection headers", false);
    const sumQuery = (query) => {
        let sum = 0;
        for (const k in query) {
            const n = parseInt(query[k], 10);
            if (n === n) sum += n;
        }
        return sum;
    };
    arena.get("/baseline11", (req, res) => {
        res.type("text/plain").send(String(sumQuery(req.query)));
    });
    arena.post("/baseline11", express.text({ type: () => true }), (req, res) => {
        let total = sumQuery(req.query);
        const n = parseInt(typeof req.body === "string" ? req.body.trim() : "", 10);
        if (n === n) total += n;
        res.type("text/plain").send(String(total));
    });
    const dataset = Array.from({ length: 50 }, (_, i) => ({
        id: i + 1,
        name: `Item ${i + 1}`,
        category: ["electronics", "tools", "garden"][i % 3],
        price: 10 + i * 1.5,
        quantity: i * 7,
        active: i % 2 === 0,
        tags: ["fast", "new"],
        rating: { score: 4.5, count: 100 + i }
    }));
    const compress = express.compression({
        encodings: ["br"],
        brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 3 } }
    });
    arena.get("/json/:count", compress, (req, res) => {
        const count = Math.min(Math.max(parseInt(req.params.count, 10) || 0, 0), dataset.length);
        const m = parseInt(req.query.m, 10) || 1;
        const items = new Array(count);
        for (let i = 0; i < count; i++) {
            const d = dataset[i];
            items[i] = { ...d, total: d.price * d.quantity * m };
        }
        res.json({ items, count });
    });
    arena.post("/echo", express.raw({ type: () => true, limit: "1mb" }), (req, res) => {
        res.type("application/octet-stream").send(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    });

    const ports = {};
    for (const [name, target] of [
        ["app", app],
        ["arena", arena]
    ]) {
        const server = target.listen(0, "127.0.0.1", () => {
            ports[name] = server.address().port;
            if (Object.keys(ports).length === 2) process.send({ type: "ready", ports });
        });
    }
    process.on("message", (msg) => {
        if (msg.type === "plan") {
            plan = msg.plan;
            seen = 0;
            process.send({ type: "planned" });
        }
    });
} else if (mode === "client") {
    // asks the same request again as soon as the whole answer is in; Content-Length only
    process.on("message", (msg) => {
        if (msg.type !== "run") return;
        const raw = Buffer.from(msg.raw, "latin1");
        let left = msg.total;
        let received = Buffer.alloc(0);
        const socket = net.connect(msg.port, "127.0.0.1", () => socket.write(raw));
        socket.setNoDelay(true);
        socket.on("data", (chunk) => {
            received = received.length ? Buffer.concat([received, chunk]) : chunk;
            for (;;) {
                const end = received.indexOf("\r\n\r\n");
                if (end === -1) return;
                const head = received.toString("latin1", 0, end).toLowerCase();
                if (!head.startsWith(`http/1.1 ${msg.status} `)) throw new Error(`unexpected answer: ${head}`);
                const length = /\r\ncontent-length: *(\d+)/.exec(head);
                if (!length) throw new Error(`no content-length: ${head}`);
                const size = end + 4 + Number(length[1]);
                if (received.length < size) return;
                received = received.subarray(size);
                if (--left === 0) {
                    socket.end();
                    process.send({ type: "done" });
                    return;
                }
                socket.write(raw);
            }
        });
        socket.on("error", (err) => {
            throw err;
        });
    });
    process.send({ type: "ready" });
} else {
    const source = path.resolve(process.env.FULMINE_PERF_SOURCE || path.join(__dirname, "../../src"));
    const label = process.argv.slice(2).join(" ");
    const cases = {
        "GET /hello": ["app", 200, "GET /hello HTTP/1.1"],
        "GET /json": ["app", 200, "GET /json HTTP/1.1"],
        "GET /users/:id?q": ["app", 200, "GET /users/42?q=x HTTP/1.1"],
        "GET /ua": ["app", 200, "GET /ua HTTP/1.1\r\nUser-Agent: probe"],
        "GET /mw/x": ["app", 200, "GET /mw/x HTTP/1.1"],
        "GET /r/x": ["app", 200, "GET /r/x HTTP/1.1"],
        "GET /missing": ["app", 404, "GET /missing HTTP/1.1"],
        "POST /echo json": [
            "app",
            200,
            'POST /echo HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 13\r\n\r\n{"a":1,"b":2}'
        ],
        "arena GET /baseline11": ["arena", 200, "GET /baseline11?a=1&b=2 HTTP/1.1"],
        "arena POST /baseline11": ["arena", 200, "POST /baseline11?a=1&b=2 HTTP/1.1\r\nContent-Length: 2\r\n\r\n20"],
        // ~13 KB a request, a thousand of them do not fit in the young generation
        "arena GET /json/:count br": ["arena", 200, "GET /json/25?m=3 HTTP/1.1\r\nAccept-Encoding: gzip, br", 250],
        "arena POST /echo": ["arena", 200, `POST /echo HTTP/1.1\r\nContent-Length: 1024\r\n\r\n${"x".repeat(1024)}`]
    };
    const which = cases[label];
    assert.ok(which, `unknown case ${label}`);
    const [target, status, request, count = 1000] = which;
    const [lines, body] = request.split("\r\n\r\n");
    const raw = `${lines}\r\nHost: localhost\r\n\r\n${body ?? ""}`;
    // past the first hundred requests and sockets, which read the ip and port up front
    const plan = { warmup: 300, count, rounds: 5 };
    const wait = (child, type) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error(`timeout waiting for ${type}`)), 30000);
            const onExit = (code, signal) => finish(new Error(`child exited ${code}/${signal} waiting for ${type}`));
            const onMessage = (msg) => {
                if (msg.type === type) finish(null, msg);
            };
            function finish(error, value) {
                clearTimeout(timer);
                child.off("message", onMessage);
                child.off("exit", onExit);
                error ? reject(error) : resolve(value);
            }
            child.on("message", onMessage);
            child.on("exit", onExit);
        });
    const start = (args, execArgv) =>
        fork(__filename, args, { execArgv, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    async function measure() {
        const server = start(
            ["server", source],
            ["--expose-gc", "--jitless", "--min-semi-space-size=16", "--max-semi-space-size=16"]
        );
        let client;
        try {
            const { ports } = await wait(server, "ready");
            client = start(["client"], []);
            await wait(client, "ready");
            let next = wait(server, "planned");
            server.send({ type: "plan", plan });
            await next;
            next = wait(server, "samples");
            const done = wait(client, "done");
            client.send({
                type: "run",
                port: ports[target],
                raw,
                status,
                total: plan.warmup + plan.count * plan.rounds + 1
            });
            const [{ samples }] = await Promise.all([next, done]);
            return { label, node: process.version, source, plan, samples };
        } finally {
            for (const child of [client, server]) if (child && child.exitCode === null) child.kill("SIGKILL");
        }
    }
    measure()
        .then((report) => console.log(JSON.stringify(report)))
        .catch((err) => {
            console.error(err);
            process.exitCode = 1;
        });
}
