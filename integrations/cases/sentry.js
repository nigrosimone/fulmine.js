// Sentry through @sentry/node: the errors it reports and the scope each request gets, on
// app.listen() and on http.createServer(app).
//
// Sentry rewrites the router package as it loads and listens to node:http's server channels.
// Fulmine does not use that package, so what it reports here comes from the channels and
// setupExpressErrorHandler alone, and the transaction is not compared: Express names it after the
// route, GET /later/:id, Fulmine after the path, GET /later/1, see docs/monitoring.md.
// Sentry is initialised before the arm is required, as its docs ask, or the Express arm is not
// rewritten at all. Nothing is sent: the transport drops it, and beforeSend keeps what is compared.

const http = require("node:http");
const Sentry = require("@sentry/node");

/** @type {any[]} */
const events = [];
Sentry.init({
    dsn: "https://public@sentry.invalid/1",
    tracesSampleRate: 1.0,
    transport: () => ({ send: async () => ({}), flush: async () => true }),
    beforeSend: (event) => {
        events.push(event);
        return null;
    }
});

const { express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13810;
const SHIM_PORT = 13811;

const app = express();
// a tag set in a middleware, which has to stay with its own request
app.use((req, res, next) => {
    Sentry.setTag("user", req.get("x-user") ?? "nobody");
    next();
});
app.get("/ok", (req, res) => res.send("ok"));
app.get("/sync", () => {
    throw new Error("thrown in the route");
});
app.get("/later/:id", async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, Number(req.query.wait) || 0));
    throw new Error(`thrown after an await, ${req.params.id}`);
});
Sentry.setupExpressErrorHandler(app);
app.use((err, req, res, next) => res.status(500).send(err.message));

/** @param {number} port @param {string} path @param {string} [user] */
function get(port, path, user) {
    return fetchTest(`http://localhost:${port}${path}`, user ? { headers: { "x-user": user } } : undefined);
}

/** What each event says about its request, in an order that does not depend on timing. */
function printEvents() {
    const lines = events.map((event) => {
        const url = event.request?.url?.replace(/:\d+\//, ":PORT/");
        return `${event.exception?.values?.[0]?.value} | ${event.request?.method} ${url} | user=${event.tags?.user}`;
    });
    for (const line of lines.sort()) console.log(line);
    events.length = 0;
}

/** @param {number} port */
async function exercise(port) {
    await sequential([() => get(port, "/ok"), () => get(port, "/sync", "sync"), () => get(port, "/later/1", "later")]);
    // two at once, the first one finishing last: each event has to carry its own request's tag. Not
    // through fetchTest, which would print the two answers in whichever order they came
    const at = (path, user) => fetch(`http://localhost:${port}${path}`, { headers: { "x-user": user } });
    await Promise.all([at("/later/a?wait=60", "a"), at("/later/b?wait=10", "b")]);
    await Sentry.flush(2000);
    printEvents();
}

app.listen(PORT, async () => {
    console.log("app.listen()");
    await exercise(PORT);

    const server = http.createServer(app);
    server.listen(SHIM_PORT, async () => {
        console.log("http.createServer(app)");
        await exercise(SHIM_PORT);
        process.exit(0);
    });
});
