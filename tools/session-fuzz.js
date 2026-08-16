// Several requests down one connection, compared against express and against themselves.
//
//   node tools/session-fuzz.js                     a few hundred sequences on a seed nobody chose
//   node tools/session-fuzz.js --rounds 500        longer
//   node tools/session-fuzz.js --seed 12345 --rounds 1   replay
//   node tools/session-fuzz.js --keep-going        do not stop at the first finding
//
// Every other tool here asks one question and hangs up. Nothing looks at what a request leaves
// behind for the next one on the same socket, and that is where a whole class of bug lives: a
// header map, a parsed query, a set of matched verbs, a response's locals, a preset the optimizer
// mutates. Any of them kept one request too long answers the second request with the first one's
// data, and no single-request tool can see it.
//
// So each round draws a small application and a sequence of requests, and asks them twice:
//
//   shared   all of them down one keep-alive connection, in order
//   fresh    each of them on a connection of its own
//
// Two verdicts come out of that, and they are not the same question:
//
//   express.shared[i] != fulmine.shared[i]                     an ordinary compatibility bug
//   fulmine.shared[i] != fulmine.fresh[i], where express agrees STATE, something was kept
//
// The second is the one this tool exists for. A request that answers differently for having
// followed another is either state that outlived its request or express doing the same thing, and
// asking express the same way tells the two apart: express keeps per-connection state too, and
// copying it is the point.
//
// The connection really is one connection: an agent with maxSockets 1 and keepAlive on, and the
// sockets are counted, so a round that quietly opened a second one is not reported as agreement.

"use strict";

const http = require("http");
const path = require("path");

const realExpress = require("express");
const fulmine = require(path.join(__dirname, "..", "src", "index.js"));

/** @param {number} seed @returns {() => number} the same sequence for the same seed */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Each one answers with something a previous request could have left behind: what it read off the
// request, what it wrote on the response, or what the router worked out about it.
const KINDS = [
    "echo-headers",
    "echo-query",
    "echo-params",
    "echo-url",
    "set-header",
    "locals",
    "cookie",
    "vary",
    "append",
    "conditional",
    "sendstatus",
    "redirect",
    "type-send",
    "body-echo",
    "settings",
    "throw",
    "next-error",
    "matched-verbs"
];

const PATHS = ["/a", "/a/:id", "/b/:id/c", "/list", "/list/:id", "/x/*rest", "/"];
const METHODS = ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE"];

/**
 * The handler for a kind, which answers with whatever that kind is about.
 *
 * @param {string} kind
 * @param {string} id
 * @returns {Function}
 */
function handlerFor(kind, id) {
    switch (kind) {
        case "echo-headers":
            return (req, res) =>
                res.json({ id, probe: req.headers["x-probe"] ?? null, ct: req.headers["content-type"] ?? null });
        case "echo-query":
            return (req, res) => res.json({ id, query: req.query });
        case "echo-params":
            return (req, res) => res.json({ id, params: req.params });
        case "echo-url":
            return (req, res) => res.json({ id, url: req.url, path: req.path, base: req.baseUrl, o: req.originalUrl });
        case "set-header":
            return (req, res) => res.set("X-From", id).send(id);
        case "locals":
            // res.locals belongs to one response; a second request seeing "seen" above one is the
            // response object, or its locals, outliving the request it was made for
            return (req, res) => {
                res.locals.seen = (res.locals.seen ?? 0) + 1;
                res.json({ id, locals: res.locals });
            };
        case "cookie":
            return (req, res) => res.cookie("c", id).send(id);
        case "vary":
            return (req, res) => res.vary("X-" + id).send(id);
        case "append":
            return (req, res) => res.append("X-Many", id).append("X-Many", "again").send(id);
        case "conditional":
            // a fixed body, so its ETag is the same every time and if-none-match can hit it
            return (req, res) => res.send("a fixed body");
        case "sendstatus":
            return (req, res) => res.sendStatus(204);
        case "redirect":
            return (req, res) => res.redirect("/somewhere/" + id);
        case "type-send":
            return (req, res) => res.type("json").send(JSON.stringify({ id }));
        case "body-echo":
            return (req, res) => res.json({ id, body: req.body ?? null });
        case "settings":
            return (req, res) => res.json({ id, etag: req.app.get("etag"), env: req.app.get("env") });
        case "throw":
            return () => {
                throw new Error("thrown by " + id);
            };
        case "next-error":
            return (req, res, next) => next(new Error("passed by " + id));
        default:
            return (req, res) => res.send(id);
    }
}

/** A small application: a body parser sometimes, a few routes, one error handler. */
function drawPlan(rng) {
    const pick = (list) => list[Math.floor(rng() * list.length)];
    const chance = (p) => rng() < p;

    const routes = [];
    const count = 2 + Math.floor(rng() * 4);
    for (let i = 0; i < count; i++) {
        routes.push({
            method: chance(0.7) ? "get" : pick(["all", "post", "put", "delete"]),
            path: pick(PATHS),
            kind: pick(KINDS),
            id: "r" + i
        });
    }
    // a route under a second verb on a path another route already answers, which is what the
    // automatic OPTIONS reply collects
    if (chance(0.5)) {
        routes.push({ method: "put", path: routes[0].path, kind: "matched-verbs", id: "rp" });
    }

    const requests = [];
    const requestCount = 2 + Math.floor(rng() * 4);
    for (let i = 0; i < requestCount; i++) {
        const target = pick(routes);
        requests.push({
            method: chance(0.65) ? (target.method === "all" ? "GET" : target.method.toUpperCase()) : pick(METHODS),
            // the route's own path with its parameters filled in, and sometimes a query
            url: target.path.replace(/:[a-z]+/g, "v").replace(/\*rest/g, "deep/er") + (chance(0.4) ? "?q=" + i : ""),
            probe: chance(0.5) ? "probe-" + i : null,
            ifNoneMatch: chance(0.25),
            body: chance(0.3) ? JSON.stringify({ n: i }) : null
        });
    }

    return { routes, requests, bodyParser: chance(0.5), settings: chance(0.4) ? { etag: false } : {} };
}

/** The plan on one framework, listening. */
async function instantiate(plan, factory) {
    const app = factory();
    for (const [key, value] of Object.entries(plan.settings)) app.set(key, value);
    if (plan.bodyParser) {
        // this framework reads a body only for the methods it is told to, which the readme states
        // as a deliberate difference from express, and express ignores the setting. Saying so here
        // compares the two on behaviour instead of rediscovering that difference every round
        app.set("body methods", ["POST", "PUT", "PATCH", "QUERY", "DELETE", "OPTIONS", "GET", "HEAD"]);
        app.use(factory.json());
    }
    for (const route of plan.routes) {
        app[route.method](route.path, handlerFor(route.kind, route.id));
    }
    // express's own page prints its own frames, which can never match
    app.use((err, req, res, next) =>
        res
            .status(500)
            .type("txt")
            .send("error: " + err.message)
    );

    if (factory === realExpress) {
        const server = http.createServer(app);
        await new Promise((r) => server.listen(0, () => r(undefined)));
        return { port: server.address().port, stop: () => new Promise((r) => server.close(() => r(undefined))) };
    }
    await new Promise((r) => app.listen(0, r));
    return { port: app.address().port, stop: () => app.close() };
}

/**
 * One request, on the agent it is given, answering with the parts worth comparing.
 *
 * @param {number} port
 * @param {any} agent
 * @param {any} request
 * @param {string|null} etag what a previous answer said, for the conditional case
 * @returns {Promise<{line: string, etag: string|null, socket: any}>}
 */
function ask(port, agent, request, etag) {
    return new Promise((resolve) => {
        const headers = { host: "x" };
        if (request.probe) headers["x-probe"] = request.probe;
        if (request.ifNoneMatch && etag) headers["if-none-match"] = etag;
        if (request.body) {
            headers["content-type"] = "application/json";
            headers["content-length"] = String(Buffer.byteLength(request.body));
        }

        let socket = null;
        const req = http.request({
            port,
            host: "127.0.0.1",
            method: request.method,
            path: request.url,
            headers,
            agent
        });
        req.on("socket", (s) => (socket = s));
        req.on("error", () => resolve({ line: "transport error", etag: null, socket }));
        req.on("response", (res) => {
            let body = "";
            res.setEncoding("latin1");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
                const shown = Object.entries(res.headers)
                    .filter(([name]) => !IGNORED.has(name))
                    .map(([name, value]) => `${name}:${value}`)
                    .sort()
                    .join(" | ");
                resolve({
                    line: `${res.statusCode} | ${shown} | ${JSON.stringify(body)}`,
                    etag: /** @type {any} */ (res.headers.etag) ?? null,
                    socket
                });
            });
        });
        if (request.body) req.write(request.body);
        req.end();
    });
}

const IGNORED = new Set(["x-powered-by", "content-length", "transfer-encoding", "date", "keep-alive", "connection"]);

/**
 * The whole sequence twice: once down one connection, once a connection each.
 *
 * @param {number} port
 * @param {any[]} requests
 * @returns {Promise<{shared: string[], fresh: string[], sockets: number}>}
 */
async function runSequence(port, requests) {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const seen = new Set();
    const shared = [];
    let etag = null;
    for (const request of requests) {
        const answer = await ask(port, agent, request, etag);
        if (answer.socket) seen.add(answer.socket);
        etag = answer.etag ?? etag;
        shared.push(answer.line);
    }
    agent.destroy();

    const fresh = [];
    let freshEtag = null;
    for (const request of requests) {
        const own = new http.Agent({ keepAlive: false, maxSockets: 1 });
        const answer = await ask(port, own, request, freshEtag);
        freshEtag = answer.etag ?? freshEtag;
        fresh.push(answer.line);
        own.destroy();
    }

    return { shared, fresh, sockets: seen.size };
}

/** The plan as the source it stands for. */
function planToSource(plan) {
    const lines = ["const app = express();"];
    for (const [key, value] of Object.entries(plan.settings))
        lines.push(`app.set(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
    if (plan.bodyParser) lines.push("app.use(express.json());");
    for (const route of plan.routes) lines.push(`app.${route.method}(${JSON.stringify(route.path)}, ${route.kind});`);
    lines.push("// then, down one connection:");
    for (const request of plan.requests) {
        const notes = [];
        if (request.probe) notes.push(`x-probe: ${request.probe}`);
        if (request.ifNoneMatch) notes.push("if-none-match from the answer before");
        if (request.body) notes.push(`body ${request.body}`);
        lines.push(`//   ${request.method} ${request.url}${notes.length ? "   (" + notes.join(", ") + ")" : ""}`);
    }
    return lines.join("\n");
}

async function main() {
    const argv = process.argv.slice(2);
    const flag = (name, fallback) => {
        const at = argv.indexOf("--" + name);
        return at === -1 ? fallback : Number(argv[at + 1]);
    };
    const rounds = flag("rounds", 200);
    const baseSeed = flag("seed", (Date.now() ^ (process.pid << 16)) >>> 0);
    const keepGoing = argv.includes("--keep-going");

    console.log(`${rounds} sequences from seed ${baseSeed}`);

    let asked = 0;
    let found = 0;

    for (let round = 0; round < rounds; round++) {
        const seed = (baseSeed + round) >>> 0;
        const plan = drawPlan(mulberry32(seed));

        let expressArm, fulmineArm;
        try {
            expressArm = await instantiate(plan, realExpress);
        } catch {
            // a shape express itself refuses is not a bug in ours
            continue;
        }
        try {
            fulmineArm = await instantiate(plan, fulmine);
        } catch (err) {
            await expressArm.stop();
            console.log(`\n=== round ${round}, seed ${seed}: this framework refused the application`);
            console.log(`  ${err.message}`);
            found++;
            if (!keepGoing) process.exit(1);
            continue;
        }

        const expressRun = await runSequence(expressArm.port, plan.requests);
        const fulmineRun = await runSequence(fulmineArm.port, plan.requests);
        asked += plan.requests.length * 2;

        const findings = [];
        for (let i = 0; i < plan.requests.length; i++) {
            // what this tool is for: an answer that changed for having followed another, where
            // express's did not
            const fulmineKept = fulmineRun.shared[i] !== fulmineRun.fresh[i];
            const expressKept = expressRun.shared[i] !== expressRun.fresh[i];
            if (fulmineKept !== expressKept) {
                findings.push({ i, kind: "STATE", express: expressRun, fulmine: fulmineRun });
                continue;
            }
            if (expressRun.shared[i] !== fulmineRun.shared[i]) {
                findings.push({ i, kind: "differs", express: expressRun, fulmine: fulmineRun });
            }
        }
        // one connection was the whole point; more than one and the comparison above says nothing
        if (fulmineRun.sockets > 1 || expressRun.sockets > 1) {
            findings.push({ i: -1, kind: "sockets", express: expressRun, fulmine: fulmineRun });
        }

        await expressArm.stop();
        await fulmineArm.stop();

        if (findings.length === 0) {
            if ((round + 1) % 25 === 0) console.log(`  ${round + 1} rounds, ${asked} requests, no finding`);
            continue;
        }

        found++;
        const first = findings[0];
        console.log(`\n=== ${first.kind} in round ${round}, seed ${seed} (replay: --seed ${seed} --rounds 1)`);
        if (first.kind === "sockets") {
            console.log(`  express opened ${expressRun.sockets} sockets, fulmine ${fulmineRun.sockets}`);
        } else {
            const r = plan.requests[first.i];
            console.log(`  request ${first.i + 1} of ${plan.requests.length}: ${r.method} ${r.url}`);
            console.log(`  express shared: ${expressRun.shared[first.i]}`);
            console.log(`  express fresh : ${expressRun.fresh[first.i]}`);
            console.log(`  fulmine shared: ${fulmineRun.shared[first.i]}`);
            console.log(`  fulmine fresh : ${fulmineRun.fresh[first.i]}`);
        }
        console.log("\n" + planToSource(plan));
        if (!keepGoing) {
            console.log(`\n${asked} requests before this`);
            process.exit(1);
        }
    }

    console.log(`\n${rounds} sequences, ${asked} requests, ${found} findings`);
    process.exit(found ? 1 : 0);
}

main();
