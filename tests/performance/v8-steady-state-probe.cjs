"use strict";

// The server warms on a mix of requests, then turns on --trace-deopt and serves the same mix
// again: what V8 prints from then on is a deopt in steady state. Run with --allow-natives-syntax.

const path = require("node:path");
const mode = process.argv[2];

if (mode) process.on("disconnect", () => process.exit(1));

const PATHS = [
    "/native",
    "/NATIVE",
    "/native?m=put",
    "/s/a.txt",
    "/s/missing",
    "/err",
    "/thrown",
    "/nowhere",
    "POST /json",
    "/lite/7?a=1",
    "POST /lite",
    "/lite-use/7",
    "/lite-async",
    "/lite-stream",
    "/utils?a=1",
    "/utils?a=2",
    "/utils?a=3",
    "/utils?a=4",
    "POST /utils"
];

if (mode === "server") {
    const fs = require("node:fs");
    const os = require("node:os");
    const v8 = require("node:v8");
    const source = path.resolve(process.argv[3]);
    const express = require(path.join(source, "index.js"));
    const Walk = require(path.join(source, "walk.js"));
    const Request = require(path.join(source, "request.js"));
    const Response = require(path.join(source, "response.js"));
    // as syntax this file would not parse without the flag, so lint and require see a call
    const status = new Function("f", "return %GetOptimizationStatus(f)");
    const prepare = new Function("f", "%PrepareFunctionForOptimization(f)");
    const optimize = new Function("f", "%OptimizeFunctionOnNextCall(f)");

    // the TurboFan bit moves between V8 versions, so it is read off a function optimized here
    const probe = (x) => x + 1;
    prepare(probe);
    probe(1);
    probe(2);
    optimize(probe);
    probe(3);
    const interpreted = (x) => x + 2;
    interpreted(1);
    // a Maglev function shares the "optimized" bit, so its bits are taken out too
    const maglev = (x) => x + 3;
    prepare(maglev);
    maglev(1);
    maglev(2);
    new Function("f", "%OptimizeMaglevOnNextCall(f)")(maglev);
    maglev(3);
    const turbofanBit = status(probe) & ~status(interpreted) & ~status(maglev);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-v8-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    const app = express();
    app.use((req, res, next) => {
        if (req.query.m) req.method = "PUT";
        next();
    });
    app.use("/s", express.static(dir));
    app.use(express.json());
    app.get("/native", (req, res) => res.send("get"));
    app.put("/native", (req, res) => res.send("put"));
    app.post("/json", (req, res) => res.json({ n: req.body.n }));
    app.get("/err", (req, res, next) => next(new Error("next")));
    app.get("/thrown", () => {
        throw new Error("thrown");
    });
    app.use((err, req, res, next) => res.status(500).send(err.message));

    // app.uwsLite and express.uwsUtils. Their classes are not exported, so the prototype comes from
    // a live request
    let liteResponse = null;
    app.uwsLite.get("/lite/:id", (req, res) => {
        liteResponse ??= Object.getPrototypeOf(res);
        res.json({ id: req.params.id, a: req.query.a });
    });
    app.uwsLite.post("/lite", { body: "json" }, (req, res) => res.status(201).json(req.body));
    const who = (req, res, next) => {
        req.who = req.get("host");
        next();
    };
    app.uwsLite.get("/lite-use/:id", { use: [who] }, (req, res) => res.json({ who: req.who, id: req.params.id }));
    app.uwsLite.get("/lite-async", { headers: ["host"] }, async (req, res) => {
        await null;
        res.send(req.get("host"));
    });
    app.uwsLite.get("/lite-stream", (req, res) => {
        res.write("a");
        res.end("b");
    });
    const utils = express.uwsUtils;
    app.uws.get("/utils", (res, req) => utils.send(res, 200, null, utils.query(req)));
    app.uws.post("/utils", (res) => utils.readJson(res, (body) => utils.send(res, 200, null, body)));

    // runRoute is left out: it is inlined into dispatch and has no optimized code of its own
    const hot = {
        "Walk#dispatch": Walk.prototype.dispatch,
        "Walk#step": Walk.prototype.step,
        Request,
        "Response#send": Response.prototype.send,
        "Response#end": Response.prototype.end
    };
    process.on("message", (msg) => {
        if (msg.type === "steady") {
            v8.setFlagsFromString("--trace-file-names");
            v8.setFlagsFromString("--trace-deopt");
            process.send({ type: "steady" });
        } else if (msg.type === "report") {
            v8.setFlagsFromString("--no-trace-deopt");
            // json, send and the utilities are inlined into these and have no optimized code of their own
            const route = (path) => app._uwsRoutes.find((entry) => entry.path === path).handler;
            hot["LiteResponse#_finish"] = liteResponse._finish;
            hot["uwsLite route"] = route("/lite/:id");
            hot["uwsLite route with use"] = route("/lite-use/:id");
            hot["app.uws route with uwsUtils"] = route("/utils");
            const optimized = {};
            for (const [name, fn] of Object.entries(hot)) optimized[name] = (status(fn) & turbofanBit) !== 0;
            fs.rmSync(dir, { recursive: true, force: true });
            process.send({ type: "report", turbofanBit, optimized }, () => process.exit(0));
        }
    });
    app.listen(0, () => process.send({ type: "ready", port: app.address().port }));
} else if (mode === "client") {
    const http = require("node:http");
    const port = Number(process.argv[3]);
    const count = Number(process.argv[4]);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
    let sent = 0;
    let done = 0;
    const one = () => {
        if (sent >= count) return;
        const entry = PATHS[sent++ % PATHS.length];
        const post = entry.startsWith("POST ");
        const body = JSON.stringify({ n: sent });
        const request = http.request(
            {
                port,
                agent,
                host: "127.0.0.1",
                method: post ? "POST" : "GET",
                path: post ? entry.slice(5) : entry,
                headers: post ? { "content-type": "application/json", "content-length": body.length } : {}
            },
            (res) => {
                res.resume();
                res.on("end", () => {
                    if (++done === count) {
                        agent.destroy();
                        process.send({ type: "done" });
                        return;
                    }
                    one();
                });
            }
        );
        request.end(post ? body : undefined);
    };
    for (let i = 0; i < 8; i++) one();
} else {
    const { fork } = require("node:child_process");
    const source = path.resolve(process.env.FULMINE_PERF_SOURCE || path.join(__dirname, "../../src"));
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_V8_COVERAGE;
    const server = fork(__filename, ["server", source], {
        execArgv: ["--allow-natives-syntax"],
        env,
        stdio: ["ignore", "pipe", "inherit", "ipc"]
    });
    let trace = "";
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", (chunk) => (trace += chunk));
    const next = (type) => new Promise((resolve) => server.once("message", (msg) => msg.type === type && resolve(msg)));
    const load = (port, count) =>
        new Promise((resolve) => {
            const client = fork(__filename, ["client", String(port), String(count)], { env });
            client.once("message", () => {
                client.kill();
                resolve(undefined);
            });
        });
    (async () => {
        const { port } = await next("ready");
        await load(port, 60000);
        server.send({ type: "steady" });
        await next("steady");
        await load(port, 60000);
        server.send({ type: "report" });
        const report = await next("report");
        await new Promise((resolve) => server.once("exit", resolve));
        // a deopt in this project's code, by the file name --trace-file-names puts in the line
        const deopts = trace
            .split("\n")
            .filter((line) => line.startsWith("[bailout") && line.includes(source))
            .map((line) => line.replace(/0x[0-9a-f]+/g, "").slice(0, 300));
        process.stdout.write(JSON.stringify({ ...report, deopts }));
    })();
}
