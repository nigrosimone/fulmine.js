// OpenTelemetry through @opentelemetry/instrumentation-http: the server span of each request, on
// app.listen() and on http.createServer(app).
//
// The instrumentation wraps http.Server.prototype.emit and reads no channel, so on µWS Fulmine
// sends the request through that wrapper, see src/tracing.js. It is registered before the arm is
// required, as its docs ask. The spans stay in memory, and only what both arms can agree on is
// printed: no ids, times or ports.

const http = require("node:http");
const api = require("@opentelemetry/api");
const { AsyncLocalStorageContextManager } = require("@opentelemetry/context-async-hooks");
const { W3CTraceContextPropagator } = require("@opentelemetry/core");
const { TracerProvider } = require("@opentelemetry/sdk-trace");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");

// the ended spans as they end: the SDK's in-memory exporter goes through an export that never
// settled here, and nothing has to leave the process
/** @type {any[]} */
const ended = [];
const collector = {
    onStart() {},
    onEnd: (/** @type {any} */ span) => ended.push(span),
    forceFlush: async () => {},
    shutdown: async () => {}
};
api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
api.trace.setGlobalTracerProvider(new TracerProvider({ spanProcessors: [collector] }));
api.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
registerInstrumentations({ instrumentations: [new HttpInstrumentation()] });

const { express } = require("../arm.js");
const { sequential } = require("../../tests/helpers.js");

const PORT = 13820;
const SHIM_PORT = 13821;
const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const PARENT_ID = "b7ad6b7169203331";

const app = express();
app.get("/ok", (req, res) => res.send("ok"));
app.get("/json/:id", (req, res) => res.json({ id: req.params.id }));
// the request's span has to be the active one in the handler, before and after an await
app.get("/active", async (req, res) => {
    const before = api.trace.getActiveSpan()?.spanContext().traceId;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = api.trace.getActiveSpan()?.spanContext().traceId;
    res.send(`${before === TRACE_ID} ${after === TRACE_ID}`);
});
app.post("/echo", express.json(), (req, res) => res.json(req.body));
app.get("/boom", () => {
    throw new Error("thrown in the route");
});
app.use((err, req, res, next) => res.status(500).send(err.message));

/** @param {number} port @param {string} path @param {RequestInit} [init] */
async function call(port, path, init = {}) {
    const headers = { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`, ...init.headers };
    const res = await fetch(`http://localhost:${port}${path}`, { ...init, headers });
    console.log(init.method ?? "GET", path, res.status, await res.text());
}

/** What each server span says about its request, sorted so timing does not matter. */
function printSpans() {
    const lines = ended.map((span) => {
        const attributes = Object.entries(span.attributes)
            .filter(([key]) => !key.endsWith(".port"))
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, value]) => `${key}=${value}`);
        const parent = span.parentSpanContext?.spanId === PARENT_ID ? "continued" : "new trace";
        return `${api.SpanKind[span.kind]} ${span.name} ${parent} status=${span.status.code} ${attributes.join(" ")}`;
    });
    for (const line of lines.sort()) console.log(line);
    ended.length = 0;
}

/** @param {number} port */
async function exercise(port) {
    await sequential([
        () => call(port, "/ok"),
        () => call(port, "/json/7"),
        () => call(port, "/active"),
        () => call(port, "/echo", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' }),
        () => call(port, "/boom"),
        () => call(port, "/missing")
    ]);
    // the span ends on the response's close, which can come a tick after the client has read it
    await new Promise((resolve) => setTimeout(resolve, 50));
    printSpans();
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
