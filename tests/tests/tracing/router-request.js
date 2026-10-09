// The express.router.request TracingChannel against express itself: start, end, asyncStart,
// asyncEnd and error for every middleware, route handler and error handler, request by request
// OFF: express 5.3.0 resolves router 2.2.0, which publishes nothing; on once a router release has pillarjs/router#196
//
// Until then tests/unit/tracing-router-request.test.js holds the same app against the sequence express
// printed with router at that commit. Left out here: an error a mounted router raises while matching,
// which express hands out at once and fulmine a microtask later, the one known difference

const dc = require("node:diagnostics_channel");
const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

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

app.listen(13333, async () => {
    await sequential(
        [
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
            ["GET", "/files/router-request.js"],
            ["GET", "/sub/hello"],
            ["GET", "/missing"]
        ].map(([method, path]) => async () => {
            events = [];
            const res = await fetchTest(`http://localhost:13333${path}`, {
                method,
                headers: method === "POST" ? { "content-type": "application/json" } : {},
                body: method === "POST" ? '{"a":1}' : undefined
            });
            await res.text();
            // the asyncEnd of a handler that answered before its promise settled
            await new Promise((resolve) => setTimeout(resolve, 20));
            console.log(method, path, res.status);
            console.log(events.map((e) => "  " + e).join("\n"));
        })
    );
    process.exit(0);
});
