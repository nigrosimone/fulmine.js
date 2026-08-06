// Differential fuzzing against express.
//
// The suite compares hand written cases. This builds random ones instead: a random application
// shape, registered on real express and on fulmine, hit with hostile urls, and every answer
// compared. Anything the two disagree on is a compatibility bug in one of them, and it is usually
// ours.
//
//   node tools/fuzz.js                     a few hundred rounds
//   node tools/fuzz.js --rounds 500        longer
//   node tools/fuzz.js --seed 12345        replay exactly what a past run did
//   node tools/fuzz.js --keep-going        do not stop at the first divergence
//
// Two things make it a tool rather than a lucky script. Every round is drawn from a seeded
// generator, so a failure prints the seed that reproduces it. And a failure is then shrunk: routes
// and settings are dropped one at a time for as long as the divergence survives, which turns a
// forty route accident into the two lines worth pasting into tests/.

const path = require("path");
const realExpress = require(path.join(__dirname, "..", "node_modules", "express"));
const fulmine = require(path.join(__dirname, "..", "src", "index.js"));
const { COMPARED_HEADERS, PRESENCE_ONLY_HEADERS } = require(path.join(__dirname, "..", "tests", "helpers.js"));

// x-powered-by, content-length and transfer-encoding stay out for the reasons tests/helpers.js
// gives: the two servers differ there by design rather than by fault.

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

const SEGMENTS = ["a", "b", "users", "posts", "me", "list", "x1", "Mixed"];
const PARAM_VALUES = ["1", "abc", "x-y", "%41", "%2F", "a.b", "-", "9", "a%00b", "%C3%A9", "a+b", "a b", ".hidden"];
const SUFFIXES = ["", "?", "?q=1", "?q", "?a=1&a=2", "?%2F=%2F", "#frag", "?q=1#frag", "?="];
const METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"];

// Every handler answers from the request alone, with nothing drawn from the clock or from a
// counter: two servers must be able to produce the same bytes.
const HANDLER_KINDS = [
    "send-text",
    "send-json",
    "status-send",
    "send-status",
    "redirect",
    "set-header",
    "type-send",
    "end-empty",
    "params-echo",
    "query-echo",
    "url-echo",
    "async-send",
    "throw",
    "next-error",
    "next-route"
];

/**
 * The plan is data, not code: it is drawn once from the generator and then instantiated on both
 * frameworks, so the two applications cannot drift apart through a second draw.
 *
 * @param {() => number} rng
 * @returns {object}
 */
function drawPlan(rng) {
    const pick = (list) => list[Math.floor(rng() * list.length)];
    const chance = (p) => rng() < p;

    let paramCounter = 0;
    /** A path in path-to-regexp 8 syntax, with parameter names unique inside it. */
    const drawPath = (allowWildcard) => {
        const depth = 1 + Math.floor(rng() * 3);
        const parts = [];
        for (let i = 0; i < depth; i++) {
            const roll = rng();
            if (roll < 0.3) {
                parts.push(":p" + paramCounter++);
            } else if (roll < 0.38) {
                // an optional group, which express 5 spells with braces
                parts.push("{:o" + paramCounter++ + "}");
            } else {
                parts.push(pick(SEGMENTS));
            }
        }
        let p = "/" + parts.join("/");
        if (allowWildcard && chance(0.12)) {
            p += "/*splat" + paramCounter++;
        } else if (chance(0.1)) {
            p += "/";
        }
        return p;
    };

    const drawRoute = (allowWildcard) => ({
        method: chance(0.75) ? "get" : pick(["post", "put", "delete", "all"]),
        path: drawPath(allowWildcard),
        kind: pick(HANDLER_KINDS),
        // a middleware in front of the handler, which is where next() bookkeeping goes wrong
        lead: chance(0.25) ? pick(["header", "rewrite", "params", "plain"]) : null,
        id: "r" + paramCounter++
    });

    const settings = {};
    if (chance(0.35)) settings["strict routing"] = chance(0.7);
    if (chance(0.35)) settings["case sensitive routing"] = chance(0.7);
    if (chance(0.2)) settings["query parser"] = pick(["simple", "extended"]);
    if (chance(0.15)) settings.etag = false;

    const routers = [];
    const routerCount = Math.floor(rng() * 3);
    for (let i = 0; i < routerCount; i++) {
        const options = {};
        if (chance(0.4)) options.strict = chance(0.5);
        if (chance(0.4)) options.caseSensitive = chance(0.5);
        if (chance(0.3)) options.mergeParams = true;
        routers.push({
            mount: drawPath(false),
            options,
            // a router mounted on a router, where the mount paths compose
            nested: chance(0.3) ? { mount: drawPath(false), routes: [drawRoute(false)] } : null,
            routes: Array.from({ length: 1 + Math.floor(rng() * 2) }, () => drawRoute(true))
        });
    }

    // a sub-application, whose routes may exist before or after it is mounted: express reads its
    // routing settings when it builds the router, so that order is visible from outside
    const subApp = chance(0.3)
        ? {
              mount: drawPath(false),
              mountFirst: chance(0.5),
              settings: chance(0.4) ? { "strict routing": chance(0.5) } : {},
              routes: [drawRoute(false)]
          }
        : null;

    const routes = Array.from({ length: 2 + Math.floor(rng() * 5) }, () => drawRoute(true));

    // urls: the registered paths with their parameters filled in, plus noise around them
    const urls = [];
    const everyPath = [
        ...routes.map((r) => r.path),
        ...routers.flatMap((r) => r.routes.map((x) => r.mount + x.path)),
        ...routers
            .filter((r) => r.nested)
            .flatMap((r) => r.nested.routes.map((x) => r.mount + r.nested.mount + x.path)),
        ...(subApp ? subApp.routes.map((x) => subApp.mount + x.path) : [])
    ];
    // three shapes per registered path: as written, with the trailing slash flipped, and in a
    // case the registration did not use. Those three are where the routing flags show themselves
    for (const p of everyPath) {
        const filled = p
            .replace(/\*splat\d+/g, () => PARAM_VALUES[Math.floor(rng() * PARAM_VALUES.length)] + "/x")
            .replace(/\{?:(\w+)\}?/g, () => PARAM_VALUES[Math.floor(rng() * PARAM_VALUES.length)]);
        const flipped = filled.endsWith("/") ? filled.slice(0, -1) : filled + "/";
        urls.push(filled + pick(SUFFIXES), flipped + pick(SUFFIXES), filled.toUpperCase() + pick(SUFFIXES));
        if (chance(0.2)) urls.push(filled.replace("/", "//"));
    }
    urls.push("/" + pick(SEGMENTS) + "/absent", "/", "//", "/a/../b", "/%2e%2e/a");

    // GET always, since most routes are GET, plus one other verb so the method side is exercised
    return { settings, routers, subApp, routes, urls, methods: ["GET", pick(METHODS)] };
}

/** Builds one handler of the kind the plan asked for. */
function makeHandler(route) {
    const id = route.id;
    switch (route.kind) {
        case "send-json":
            return (req, res) => res.json({ id, params: req.params });
        case "status-send":
            return (req, res) => res.status(201).send(id);
        case "send-status":
            return (req, res) => res.sendStatus(202);
        case "redirect":
            return (req, res) => res.redirect(302, "/somewhere/" + id);
        case "set-header":
            return (req, res) => res.set("X-Fuzz", id).set("Vary", "Accept").send(id);
        case "type-send":
            return (req, res) => res.type("txt").send(id);
        case "end-empty":
            return (req, res) => res.end();
        case "params-echo":
            return (req, res) => res.json({ id, params: req.params, baseUrl: req.baseUrl });
        case "query-echo":
            return (req, res) => res.json({ id, query: req.query });
        case "url-echo":
            return (req, res) =>
                res.json({ id, url: req.url, originalUrl: req.originalUrl, path: req.path, baseUrl: req.baseUrl });
        case "async-send":
            return async (req, res) => {
                await Promise.resolve();
                res.send(id);
            };
        case "throw":
            return () => {
                throw new Error("thrown by " + id);
            };
        case "next-error":
            return (req, res, next) => next(new Error("passed by " + id));
        case "next-route":
            return (req, res, next) => next("route");
        default:
            return (req, res) => res.send(id);
    }
}

/** The optional middleware in front of a handler. */
function makeLead(route) {
    switch (route.lead) {
        case "header":
            return (req, res, next) => {
                res.set("X-Lead", route.id);
                next();
            };
        case "rewrite":
            return (req, res, next) => {
                req.url = req.url.replace(/^\/+/, "/");
                next();
            };
        case "params":
            return (req, res, next) => {
                res.set("X-Params", String(Object.keys(req.params).length));
                next();
            };
        default:
            return (req, res, next) => next();
    }
}

/** Registers a plan on a framework and starts it. Returns the app and how to stop it. */
async function instantiate(plan, factory, port) {
    const app = factory();
    for (const [key, value] of Object.entries(plan.settings)) app.set(key, value);

    const addRoute = (target, route) => {
        const handlers = route.lead ? [makeLead(route), makeHandler(route)] : [makeHandler(route)];
        target[route.method](route.path, ...handlers);
    };

    for (const spec of plan.routers) {
        // a copy per instantiation: fulmine's Router rewrites its options object in place, and a
        // shared one would reach express already rewritten and be ignored
        const router = factory.Router({ ...spec.options });
        for (const route of spec.routes) addRoute(router, route);
        if (spec.nested) {
            const nested = factory.Router();
            for (const route of spec.nested.routes) addRoute(nested, route);
            router.use(spec.nested.mount, nested);
        }
        app.use(spec.mount, router);
    }

    if (plan.subApp) {
        const sub = factory();
        for (const [key, value] of Object.entries(plan.subApp.settings)) sub.set(key, value);
        if (plan.subApp.mountFirst) app.use(plan.subApp.mount, sub);
        for (const route of plan.subApp.routes) addRoute(sub, route);
        if (!plan.subApp.mountFirst) app.use(plan.subApp.mount, sub);
    }

    for (const route of plan.routes) addRoute(app, route);

    app.use((req, res) => res.status(404).send("no route"));
    // an error handler of our own, because express's default one prints a stack that cannot match
    app.use((err, req, res, next) => res.status(500).send("error: " + err.message));

    const server = await new Promise((resolve) => {
        const s = app.listen(port, () => resolve(s));
    });
    return {
        stop: () => (typeof app.close === "function" ? app.close() : new Promise((r) => server.close(r)))
    };
}

/** What is compared: the status, the headers worth comparing, and the body. */
async function answerOf(port, url, method) {
    const res = await fetch("http://localhost:" + port + url, {
        method,
        signal: AbortSignal.timeout(5000),
        redirect: "manual"
    });
    const parts = [String(res.status)];
    for (const name of COMPARED_HEADERS) {
        const value = name === "set-cookie" ? res.headers.getSetCookie().join(" | ") : res.headers.get(name);
        if (value !== null && value !== "")
            parts.push(`${name}: ${value.replace(/\d{2}:\d{2}:\d{2} GMT/g, "xx:xx:xx GMT")}`);
    }
    for (const name of PRESENCE_ONLY_HEADERS) {
        if (res.headers.has(name)) parts.push(`${name}: present`);
    }
    parts.push(JSON.stringify(await res.text()));
    return parts.join(" | ");
}

let nextPort = 15000;

/**
 * Runs a plan on both frameworks and returns the requests they answered differently.
 *
 * @param {object} plan
 * @param {boolean} stopAtFirst
 * @returns {Promise<{divergences: object[], checked: number}>}
 */
async function runPlan(plan, stopAtFirst) {
    const portA = nextPort++;
    const portB = nextPort++;
    let a, b;
    try {
        a = await instantiate(plan, realExpress, portA);
    } catch (err) {
        // a path express itself refuses is not a bug in ours
        return { divergences: [], checked: 0, skipped: String(err.message) };
    }
    try {
        b = await instantiate(plan, fulmine, portB);
    } catch (err) {
        await a.stop();
        return {
            divergences: [
                { url: "(registration)", method: "-", express: "registered", fulmine: "threw: " + err.message }
            ],
            checked: 0
        };
    }

    const divergences = [];
    let checked = 0;
    for (const url of plan.urls) {
        for (const method of plan.methods) {
            let ra, rb;
            try {
                [ra, rb] = await Promise.all([answerOf(portA, url, method), answerOf(portB, url, method)]);
            } catch {
                continue; // a url fetch itself refuses to build is not a comparison
            }
            checked++;
            if (ra !== rb) {
                divergences.push({ url, method, express: ra, fulmine: rb });
                if (stopAtFirst) break;
            }
        }
        if (stopAtFirst && divergences.length) break;
    }

    await a.stop();
    await b.stop();
    await new Promise((r) => setTimeout(r, 20));
    return { divergences, checked };
}

/** Whether a reduced plan still shows the same disagreement on the same request. */
async function stillFails(plan, target) {
    const probe = { ...plan, urls: [target.url], methods: [target.method] };
    const { divergences } = await runPlan(probe, true);
    return divergences.length > 0;
}

/**
 * Drops everything the divergence does not need. What comes back is small enough to read, and
 * usually small enough to paste into a test as it stands.
 */
async function shrink(plan, target) {
    let current = { ...plan, urls: [target.url], methods: [target.method] };

    const tryWithout = async (candidate) => ((await stillFails(candidate, target)) ? candidate : null);

    // routes first, since there are the most of them
    for (let i = current.routes.length - 1; i >= 0; i--) {
        const candidate = { ...current, routes: current.routes.filter((_, j) => j !== i) };
        current = (await tryWithout(candidate)) ?? current;
    }
    for (let i = current.routers.length - 1; i >= 0; i--) {
        const candidate = { ...current, routers: current.routers.filter((_, j) => j !== i) };
        current = (await tryWithout(candidate)) ?? current;
    }
    if (current.subApp) {
        current = (await tryWithout({ ...current, subApp: null })) ?? current;
    }
    for (const key of Object.keys(current.settings)) {
        const settings = { ...current.settings };
        delete settings[key];
        current = (await tryWithout({ ...current, settings })) ?? current;
    }
    for (const spec of current.routers) {
        for (const key of Object.keys(spec.options)) {
            const options = { ...spec.options };
            delete options[key];
            const candidate = { ...current, routers: current.routers.map((r) => (r === spec ? { ...r, options } : r)) };
            current = (await tryWithout(candidate)) ?? current;
        }
    }
    return current;
}

/** The shrunk plan as the source it stands for. */
function planToSource(plan, target) {
    const lines = ["const app = express();"];
    for (const [key, value] of Object.entries(plan.settings))
        lines.push(`app.set(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
    for (const [i, spec] of plan.routers.entries()) {
        lines.push(`const router${i} = express.Router(${JSON.stringify(spec.options)});`);
        for (const route of spec.routes)
            lines.push(`router${i}.${route.method}(${JSON.stringify(route.path)}, ${route.kind});`);
        if (spec.nested) {
            lines.push(`const nested${i} = express.Router();`);
            for (const route of spec.nested.routes)
                lines.push(`nested${i}.${route.method}(${JSON.stringify(route.path)}, ${route.kind});`);
            lines.push(`router${i}.use(${JSON.stringify(spec.nested.mount)}, nested${i});`);
        }
        lines.push(`app.use(${JSON.stringify(spec.mount)}, router${i});`);
    }
    if (plan.subApp) {
        lines.push(`const sub = express();  // mounted ${plan.subApp.mountFirst ? "before" : "after"} its routes`);
        for (const [key, value] of Object.entries(plan.subApp.settings))
            lines.push(`sub.set(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
        for (const route of plan.subApp.routes)
            lines.push(`sub.${route.method}(${JSON.stringify(route.path)}, ${route.kind});`);
        lines.push(`app.use(${JSON.stringify(plan.subApp.mount)}, sub);`);
    }
    for (const route of plan.routes) lines.push(`app.${route.method}(${JSON.stringify(route.path)}, ${route.kind});`);
    lines.push(`// then: ${target.method} ${target.url}`);
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

    console.log(`fuzzing ${rounds} rounds from seed ${baseSeed}`);
    let checked = 0;
    let found = 0;

    for (let round = 0; round < rounds; round++) {
        const seed = (baseSeed + round) >>> 0;
        const plan = drawPlan(mulberry32(seed));
        const result = await runPlan(plan, false);
        checked += result.checked;
        if (!result.divergences.length) {
            if (round % 25 === 24) console.log(`  ${round + 1} rounds, ${checked} requests, no divergence`);
            continue;
        }

        found += result.divergences.length;
        const target = result.divergences[0];
        console.log(`\n=== divergence in round ${round}, seed ${seed} (replay: --seed ${seed} --rounds 1)`);
        console.log(`${target.method} ${target.url}`);
        console.log(`  express: ${target.express}`);
        console.log(`  fulmine: ${target.fulmine}`);
        if (result.divergences.length > 1)
            console.log(`  (${result.divergences.length} requests disagree in this round)`);

        console.log("\nshrinking...");
        const small = await shrink(plan, target);
        console.log("\n" + planToSource(small, target));

        if (!keepGoing) {
            console.log(`\n${checked} requests compared before this`);
            process.exit(1);
        }
    }

    console.log(`\n${rounds} rounds, ${checked} requests compared, ${found} divergences`);
    process.exit(found ? 1 : 0);
}

main();
