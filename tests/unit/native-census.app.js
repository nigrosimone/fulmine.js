// For native-census.test.js: prints as JSON the calls on µWS's request and response, per request.
// Requests are written by hand on a socket, so the headers are exactly the ones listed.

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
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

const files = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-census-"));
fs.writeFileSync(path.join(files, "small.txt"), "small file");
process.on("exit", () => fs.rmSync(files, { recursive: true, force: true }));

const app = express();

// the plain answers
app.get("/hello", (req, res) => res.send("hello"));
app.get("/json", (req, res) => res.json({ a: 1 }));
app.get("/created", (req, res) => res.status(201).json({ a: 1 }));
app.get("/headers", (req, res) => {
    res.set("X-One", "1").set("X-Two", "2").set("X-Three", "3");
    res.cookie("session", "abc", { httpOnly: true });
    res.send("headers");
});
app.get("/chunks", (req, res) => {
    res.write("a");
    res.write("b");
    res.end("c");
});
app.get("/redirect", (req, res) => res.redirect("/hello"));
app.get("/status", (req, res) => res.sendStatus(204));
// what the route reads from the request
app.get("/users/:id", (req, res) => res.json({ id: req.params.id, q: req.query.q }));
app.get("/ip", (req, res) => res.send(req.ip));
app.get("/ua", (req, res) => res.send(req.get("user-agent")));
app.get("/socket", (req, res) => {
    res.send(typeof req.socket.encrypted);
});
// bodies
app.post("/echo", express.json(), (req, res) => res.json(req.body));
app.post("/form", express.urlencoded(), (req, res) => res.json(req.body));
app.post("/text", express.text(), (req, res) => res.send(req.body));
app.post("/small", express.json({ limit: 10 }), (req, res) => res.json(req.body));
app.use("/parsed", express.json());
app.get("/parsed", (req, res) => res.send(String(req.body)));
// files
app.get("/file", (req, res) => res.sendFile(path.join(files, "small.txt")));
app.use("/static", express.static(files));
// later, chained, mounted, failing
app.get("/async", async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    res.send("async");
});
app.use("/mw", (req, res, next) => next());
app.get("/mw/x", (req, res) => res.send("mw"));
const router = express.Router();
router.get("/x", (req, res) => res.send("routed"));
app.use("/r", router);

// the error handler is judged for the whole app, so the failing routes have an app of their own
const failing = express();
failing.get("/hello", (req, res) => res.send("hello"));
failing.get("/throw", () => {
    throw new Error("sync");
});
failing.get("/reject", async () => {
    throw new Error("async");
});
failing.use((err, req, res, next) => res.status(500).send(err.message));

// a second app behind a proxy, where req.ip comes from X-Forwarded-For
const proxied = express();
proxied.set("trust proxy", true);
proxied.get("/ip", (req, res) => res.send(req.ip));

/** [label, which app, the raw request line and headers, a body after an empty line] */
const ASKED = [
    ["GET /hello", "app", "GET /hello HTTP/1.1"],
    ["HEAD /hello", "app", "HEAD /hello HTTP/1.1"],
    ["OPTIONS /hello", "app", "OPTIONS /hello HTTP/1.1"],
    ["GET /hello, conditional", "app", 'GET /hello HTTP/1.1\r\nIf-None-Match: W/"5-qvTGHdzF6KLavt4PO0gs2a6pQ00"'],
    ["GET /hello, connection close", "app", "GET /hello HTTP/1.1\r\nConnection: close"],
    ["GET /json", "app", "GET /json HTTP/1.1"],
    ["GET /created", "app", "GET /created HTTP/1.1"],
    ["GET /headers", "app", "GET /headers HTTP/1.1"],
    ["GET /chunks", "app", "GET /chunks HTTP/1.1"],
    ["GET /redirect", "app", "GET /redirect HTTP/1.1"],
    ["GET /status", "app", "GET /status HTTP/1.1"],
    ["GET /users/42?q=x", "app", "GET /users/42?q=x HTTP/1.1"],
    ["GET /users/%41", "app", "GET /users/%41 HTTP/1.1"],
    ["GET /ip", "app", "GET /ip HTTP/1.1"],
    ["GET /ip, trust proxy", "proxied", "GET /ip HTTP/1.1\r\nX-Forwarded-For: 10.0.0.1"],
    ["GET /ua", "app", "GET /ua HTTP/1.1\r\nUser-Agent: census"],
    ["GET /socket", "app", "GET /socket HTTP/1.1"],
    ["POST /echo", "app", 'POST /echo HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{"a":1}'],
    [
        "POST /form",
        "app",
        "POST /form HTTP/1.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 3\r\n\r\na=1"
    ],
    ["POST /text", "app", "POST /text HTTP/1.1\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\ntext"],
    [
        "POST /small, over the limit",
        "app",
        'POST /small HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 20\r\n\r\n{"a":"0123456789ab"}'
    ],
    ["GET /parsed", "app", "GET /parsed HTTP/1.1"],
    [
        "GET /parsed, declaring a body",
        "app",
        "GET /parsed HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"
    ],
    ["GET /file", "app", "GET /file HTTP/1.1"],
    ["GET /static/small.txt", "app", "GET /static/small.txt HTTP/1.1"],
    ["GET /async", "app", "GET /async HTTP/1.1"],
    ["GET /mw/x", "app", "GET /mw/x HTTP/1.1"],
    ["GET /r/x", "app", "GET /r/x HTTP/1.1"],
    ["GET /hello, with an error handler", "failing", "GET /hello HTTP/1.1"],
    ["GET /throw", "failing", "GET /throw HTTP/1.1"],
    ["GET /reject", "failing", "GET /reject HTTP/1.1"],
    ["GET /missing", "app", "GET /missing HTTP/1.1"]
];

/**
 * Writes one request on its own connection and waits for the whole answer before closing it: µWS
 * takes a half-closed socket for a client gone, and aborts a response still on its way.
 *
 * @param {number} port
 * @param {string} head the request line and headers, a body after an empty line
 * @returns {Promise<void>}
 */
function ask(port, head) {
    const [lines, body] = head.split("\r\n\r\n");
    const raw = `${lines}\r\nHost: localhost\r\n\r\n${body ?? ""}`;
    const isHead = lines.startsWith("HEAD ");
    return new Promise((resolve) => {
        let received = Buffer.alloc(0);
        const socket = net.connect(port, "127.0.0.1", () => socket.write(raw));
        const done = () => {
            socket.destroy();
            resolve();
        };
        socket.on("data", (chunk) => {
            received = Buffer.concat([received, chunk]);
            const text = received.toString("latin1");
            const end = text.indexOf("\r\n\r\n");
            if (end === -1) {
                return;
            }
            const headers = text.slice(0, end).toLowerCase();
            const status = Number(headers.slice(9, 12));
            if (isHead || status === 204 || status === 304) {
                return done();
            }
            const length = /\r\ncontent-length: *(\d+)/.exec(headers);
            if (length) {
                if (received.length - end - 4 >= Number(length[1])) {
                    done();
                }
            } else if (/\r\ntransfer-encoding: *chunked/.test(headers) && text.endsWith("0\r\n\r\n")) {
                done();
            }
        });
        socket.on("close", () => resolve());
        socket.on("error", () => resolve());
    });
}

/** @type {Record<string, number>} */
const ports = {};
for (const [name, server] of /** @type {const} */ ([
    ["app", app],
    ["failing", failing],
    ["proxied", proxied]
])) {
    const listening = server.listen(0, () => {
        ports[name] = listening.address().port;
        if (Object.keys(ports).length === 3) {
            run();
        }
    });
}

async function run() {
    // past the first hundred requests, which read the ip up front (see the Request constructor)
    for (let i = 0; i < 110; i++) {
        await ask(ports.app, "GET /hello HTTP/1.1");
        await ask(ports.failing, "GET /hello HTTP/1.1");
        await ask(ports.proxied, "GET /ip HTTP/1.1");
    }
    /** @type {Record<string, Record<string, number>|string>} */
    const report = {};
    for (const [label, server, head] of ASKED) {
        const before = requests.length;
        await ask(ports[server], head);
        // what an async route does after the response, and the epilogues on a microtask
        await new Promise((resolve) => setTimeout(resolve, 20));
        report[label] = requests.length === before + 1 ? requests[before] : `${requests.length - before} requests`;
    }
    process.stdout.write(JSON.stringify(report, null, 2));
    process.exit(0);
}
