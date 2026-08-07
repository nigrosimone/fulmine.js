// The demo behind fulmine-demo.fly.dev. It deliberately shows what a drop-in replacement means
// rather than a throughput figure: the number a shared virtual machine could produce would say
// more about the machine than about the framework, and the readme already points at benchmarks
// run by other people on hardware they describe.
//
// Everything here is ordinary Express code. The only line that is not is the first one.
const express = require("fulmine.js"); // instead of require("express")

const helmet = require("helmet");
const compression = require("compression");
const cors = require("cors");
const session = require("express-session");
const morgan = require("morgan");
const onHeaders = require("on-headers");
const path = require("path");

const app = express();
const started = Date.now();
let served = 0;

// Server-Timing, so the browser's own tools say how long this server took rather than the page
// claiming it. DevTools draws these under the request's timing panel, and any script on the page
// can read the same numbers through PerformanceServerTiming, which is what /api/hello shows.
// https://web.dev/articles/custom-metrics#server-timing-api
//
// First in the stack, and it writes the header through on-headers rather than around next():
// everything mounted below happens inside this middleware's own call, so the number is only known
// when the response is about to go out. on-headers is the hook for exactly that moment, and it is
// what compression, morgan and express-session below already use, so wrapping writeHead by hand
// here lands after they have flushed and throws.
app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    const marks = [];
    // what a route can add to the picture: res.timing("db", 12.3) and it lands in the header
    res.timing = (name, ms, description) => {
        marks.push(`${name};dur=${Number(ms).toFixed(2)}${description ? `;desc="${description}"` : ""}`);
        return res;
    };
    onHeaders(res, () => {
        const total = Number(process.hrtime.bigint() - startedAt) / 1e6;
        // "app" is the whole of this handler chain, which is what the browser can compare against
        // its own view of the request. The name is short because it is drawn in a narrow column
        res.setHeader("Server-Timing", [...marks, `app;dur=${total.toFixed(2)};desc="Fulmine"`].join(", "));
    });
    next();
});

app.use(morgan("tiny"));
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(
    session({
        secret: process.env.SESSION_SECRET || "a demo secret, not a real one",
        resave: false,
        saveUninitialized: true,
        cookie: { sameSite: "lax" }
    })
);
app.use((req, res, next) => {
    served++;
    next();
});

// an hour of caching and the immutable hint: the page is the demo's shop window, and a
// browser that has been here should not ask for the same three files again
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

/** What this process is and how long it has been up, which is all the page needs to prove it is live. */
app.get("/api/hello", (req, res) => {
    res.json({
        message: "Served by Fulmine on µWebSockets.js",
        fulmine: require("fulmine.js/package.json").version,
        node: process.version,
        uptimeSeconds: Math.round((Date.now() - started) / 1000),
        requestsSinceBoot: served
    });
});

/** Route parameters and the query string, the shapes an Express application is made of. */
app.get("/api/users/:id/posts", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 3, 20);
    res.json({
        user: req.params.id,
        limit,
        posts: Array.from({ length: limit }, (_, i) => ({ id: i + 1, title: `Post ${i + 1}` }))
    });
});

/** express-session, unmodified, keeping state across requests. */
app.get("/api/visits", (req, res) => {
    const s = /** @type {any} */ (req).session;
    s.visits = (s.visits || 0) + 1;
    res.json({ visits: s.visits, sessionId: s.id?.slice(0, 8) });
});

/** What the request looked like, so helmet's response headers can be compared against it. */
app.get("/api/echo", (req, res) => {
    res.json({
        method: req.method,
        path: req.path,
        query: req.query,
        ip: req.ip,
        userAgent: req.get("user-agent")
    });
});

app.post("/api/echo", (req, res) => {
    res.status(201).json({ received: req.body });
});

// One room per path parameter, which is app.ws() doing the two things the readme promises: the
// upgrade decides whether the socket opens, and the request stays reachable as ws.req.
app.ws("/ws/:room", {
    idleTimeout: 120,
    maxPayloadLength: 4 * 1024,
    upgrade(req, res) {
        const room = String(req.params.room);
        if (!/^[a-z0-9-]{1,24}$/.test(room)) {
            return res.sendStatus(400);
        }
        req.room = "room:" + room;
    },
    open(ws) {
        ws.subscribe(ws.req.room);
        ws.send(JSON.stringify({ type: "joined", room: ws.req.params.room, people: app.numSubscribers(ws.req.room) }));
        app.publish(ws.req.room, JSON.stringify({ type: "people", people: app.numSubscribers(ws.req.room) }));
    },
    message(ws, message) {
        const text = Buffer.from(message).toString().slice(0, 500);
        if (!text.trim()) return;
        app.publish(ws.req.room, JSON.stringify({ type: "message", text, at: Date.now() }));
    },
    close(ws) {
        app.publish(ws.req.room, JSON.stringify({ type: "people", people: app.numSubscribers(ws.req.room) - 1 }));
    }
});

/** This file, so a visitor can check that the page above is served by ordinary Express code. */
app.get("/source", (req, res) => {
    res.type("text/plain; charset=utf-8").sendFile(__filename);
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

const port = Number(process.env.PORT) || 3000;
app.listen(port, "0.0.0.0", () => {
    console.log(`fulmine demo listening on ${port}`);
});
