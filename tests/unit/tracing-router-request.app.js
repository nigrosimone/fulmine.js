// The app of tracing-router-request.test.js: what it publishes on the express.router.request
// TracingChannel, request by request. node tracing-router-request.app.js <express module> [node-http]
// The expected output is what express 5.3.0 printed with pillarjs/router at 8759eec (#196), the
// first commit with the channel: once a router release has it, this moves to tests/tests as a
// comparison test.

const dc = require("node:diagnostics_channel");
const express = require(process.argv[2]);

/** @type {string[]} */
let events = [];
const describe = (phase, ctx) =>
    [
        phase,
        ctx.layer?.name,
        ctx.errorHandler ? "errorHandler" : "",
        ctx.error ? `error=${ctx.error.message ?? ctx.error}` : "",
        ctx.req?.route ? `route=${ctx.req.route.path}` : "",
        typeof ctx.layer?.handle
    ]
        .filter(Boolean)
        .join(" ");
dc.tracingChannel("express.router.request").subscribe({
    start: (ctx) => events.push(describe("start", ctx)),
    end: (ctx) => events.push(describe("end", ctx)),
    asyncStart: (ctx) => events.push(describe("asyncStart", ctx)),
    asyncEnd: (ctx) => events.push(describe("asyncEnd", ctx)),
    error: (ctx) => events.push(describe("error", ctx))
});

const app = express();
app.set("etag", false);

app.use(function logger(req, res, next) {
    next();
});
app.use((req, res, next) => next());

app.get("/plain", function getPlain(req, res) {
    res.send("plain");
});
app.get(
    "/users/:id",
    function loadUser(req, res, next) {
        next();
    },
    function sendUser(req, res) {
        res.send(req.params.id);
    }
);
app.get("/async", async function asyncHandler(req, res) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    res.send("async");
});
app.get("/next-error", function failing(req, res, next) {
    next(new Error("boom"));
});
app.get("/throw", function throwing() {
    throw new Error("sync boom");
});
app.get("/reject", async function rejecting() {
    throw new Error("async boom");
});
app.get(
    "/recovered",
    function failingAgain(req, res, next) {
        next(new Error("recover me"));
    },
    function recoverInRoute(err, req, res, next) {
        res.send(`recovered ${err.message}`);
    }
);
app.get("/skip", function skipper(req, res, next) {
    next("route");
});
app.get("/skip", function afterSkip(req, res) {
    res.send("after skip");
});
app.post("/json", express.json(), function echo(req, res) {
    res.json(req.body);
});
// a parser in front of a GET, which finds no body and goes on
app.use("/parsed", express.json());
app.get("/parsed", function parsed(req, res) {
    res.send(String(req.body));
});

app.use("/files", express.static(__dirname));

const router = express.Router();
router.use(function routerMiddleware(req, res, next) {
    next();
});
router.get("/param/:value", function paramHandler(req, res) {
    res.send(req.params.value);
});
router.get("/inner", function innerHandler(req, res, next) {
    next(new Error("inner boom"));
});
app.use("/mounted", router);

const sub = express();
sub.get("/hello", function subHandler(req, res) {
    res.send("sub");
});
app.use("/sub", sub);

app.use(function finalErrorHandler(err, req, res, next) {
    res.status(500).send(`handled ${err.message}`);
});

// node-http serves it through http.createServer(app) instead of app.listen()
const server =
    process.argv[3] === "node-http" ? require("node:http").createServer(app).listen(0, run) : app.listen(0, run);

async function run() {
    const port = server.address().port;
    const paths = [
        ["GET", "/plain"],
        ["GET", "/users/7"],
        ["GET", "/async"],
        ["GET", "/next-error"],
        ["GET", "/throw"],
        ["GET", "/reject"],
        ["GET", "/recovered"],
        ["GET", "/skip"],
        ["POST", "/json"],
        ["GET", "/json"],
        ["GET", "/parsed"],
        ["GET", "/mounted/inner"],
        // a parameter the router cannot decode, an error no layer raised
        ["GET", "/mounted/param/%E0%A4%A"],
        ["GET", "/files/tracing-router-request.expected.txt"],
        ["GET", "/sub/hello"],
        ["GET", "/missing"]
    ];
    for (const [method, path] of paths) {
        events = [];
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers: method === "POST" ? { "content-type": "application/json" } : {},
            body: method === "POST" ? '{"a":1}' : undefined
        });
        await res.text();
        // the asyncEnd of a handler that answered before its promise settled
        await new Promise((resolve) => setTimeout(resolve, 20));
        console.log(method, path, res.status);
        console.log(events.map((e) => "  " + e).join("\n"));
    }
    process.exit(0);
}
