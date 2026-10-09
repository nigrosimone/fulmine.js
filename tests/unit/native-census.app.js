// The app of native-census.test.js: how many times each method of µWS's request and response is
// called for one request, route by route. node native-census.app.js prints them as JSON.
// µWS's App is wrapped before fulmine loads it, so every handler fulmine registers counts the calls
// made on the response it was given, for as long as it lives, and on the request while it runs.

const path = require("node:path");
const uWS = require("uWebSockets.js");

/** @type {WeakMap<object, Record<string, number>>} */
const onResponse = new WeakMap();
/** @type {Record<string, number>|null} the request is only valid while its handler runs */
let onRequest = null;
const patched = new WeakSet();

/**
 * @param {object} instance
 * @param {(self: object) => Record<string, number>|null|undefined} countsOf
 */
function count(instance, countsOf) {
    const proto = Object.getPrototypeOf(instance);
    if (patched.has(proto)) {
        return;
    }
    patched.add(proto);
    for (const name of Object.getOwnPropertyNames(proto)) {
        const original = Object.getOwnPropertyDescriptor(proto, name)?.value;
        if (typeof original !== "function" || name === "constructor") {
            continue;
        }
        proto[name] = function (...args) {
            const counts = countsOf(this);
            if (counts) {
                counts[name] = (counts[name] ?? 0) + 1;
            }
            return original.apply(this, args);
        };
    }
}

/** @type {Record<string, number>[]} one per request, in the order they came */
const requests = [];
const App = uWS.App;
uWS.App = function (...args) {
    const app = App.apply(this, args);
    for (const method of ["get", "post", "put", "del", "patch", "head", "options", "any"]) {
        const register = app[method];
        app[method] = function (pattern, handler) {
            if (typeof handler === "function") {
                const inner = handler;
                handler = (res, req) => {
                    count(res, (self) => onResponse.get(self));
                    count(req, () => onRequest);
                    const counts = {};
                    requests.push(counts);
                    onResponse.set(res, counts);
                    onRequest = counts;
                    try {
                        return inner(res, req);
                    } finally {
                        onRequest = null;
                    }
                };
            }
            return register.call(this, pattern, handler);
        };
    }
    return app;
};

const express = require(path.join(__dirname, "..", "..", "src", "index.js"));
const app = express();

app.get("/hello", (req, res) => res.send("hello"));
app.get("/json", (req, res) => res.json({ a: 1 }));
app.get("/users/:id", (req, res) => res.json({ id: req.params.id, q: req.query.q }));
app.get("/ip", (req, res) => res.send(req.ip));
app.get("/ua", (req, res) => res.send(req.get("user-agent")));
app.post("/echo", express.json(), (req, res) => res.json(req.body));
app.use("/parsed", express.json());
app.get("/parsed", (req, res) => res.send(String(req.body)));
app.get("/async", async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    res.send("async");
});
app.use("/mw", (req, res, next) => next());
app.get("/mw/x", (req, res) => res.send("mw"));
app.get("/socket", (req, res) => {
    res.send(typeof req.socket.encrypted);
});

/** what is asked, with a body for the POST */
const ASKED = [
    ["GET", "/hello"],
    ["GET", "/json"],
    ["GET", "/users/42?q=x"],
    ["GET", "/ip"],
    ["GET", "/ua"],
    ["POST", "/echo"],
    ["GET", "/parsed"],
    ["GET", "/async"],
    ["GET", "/mw/x"],
    ["GET", "/socket"],
    ["GET", "/missing"]
];

const server = app.listen(0, async () => {
    const port = server.address().port;
    // past the first hundred requests, which read the ip up front to see whether the app asks for
    // it too late (see the Request constructor): what is counted is the steady state
    for (let i = 0; i < 110; i++) {
        await fetch(`http://127.0.0.1:${port}/hello`).then((res) => res.text());
    }
    /** @type {Record<string, Record<string, number>>} */
    const report = {};
    for (const [method, url] of ASKED) {
        const before = requests.length;
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
            method,
            headers: method === "POST" ? { "content-type": "application/json" } : {},
            body: method === "POST" ? '{"a":1}' : undefined
        });
        await res.text();
        // what an async route does after the response, and the epilogues on a microtask
        await new Promise((resolve) => setTimeout(resolve, 20));
        report[`${method} ${url}`] =
            requests.length === before + 1 ? requests[before] : { requests: requests.length - before };
    }
    process.stdout.write(JSON.stringify(report, null, 2));
    process.exit(0);
});
