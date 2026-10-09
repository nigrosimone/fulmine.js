// The app of tracing-http-server.test.js: node:http's server channels as a tracer sees them.
// node tracing-http-server.app.js <express module> [node-http]
// Through http.createServer(app) node publishes them; on µWS fulmine does, and the output has to
// be the same. The subscriber does what Sentry's does: on request.start it wraps the server's emit
// in a Proxy that runs the "request" event inside a scope of its own.

const dc = require("node:diagnostics_channel");
const { AsyncLocalStorage } = require("node:async_hooks");
const express = require(process.argv[2]);

const scope = new AsyncLocalStorage();
/** @type {string[]} */
const events = [];
const wrapped = new WeakSet();
let ids = 0;

dc.subscribe("http.server.response.created", ({ request }) => events.push(`created ${request.method} ${request.url}`));
dc.subscribe("http.server.request.start", ({ request, response, socket, server }) => {
    events.push(
        `start ${request.method} ${request.url} socket=${typeof socket.remoteAddress} server=${server.address().port === port} ` +
            `on=${typeof response.on}`
    );
    if (!wrapped.has(server)) {
        wrapped.add(server);
        server.emit = new Proxy(server.emit, {
            apply(target, thisArg, args) {
                if (args[0] !== "request") {
                    return target.apply(thisArg, args);
                }
                return scope.run({ id: ++ids }, () => target.apply(thisArg, args));
            }
        });
    }
    response.once("close", () => events.push(`close ${request.url} ${response.statusCode}`));
});
dc.subscribe("http.server.response.finish", ({ request, response }) =>
    events.push(`finish ${request.method} ${request.url} ${response.statusCode}`)
);

const app = express();
app.set("etag", false);
app.get("/sync", (req, res) => {
    events.push(`handler /sync scope=${scope.getStore()?.id}`);
    res.send("sync");
});
app.get("/async", async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    events.push(`handler /async scope=${scope.getStore()?.id}`);
    res.send("async");
});
app.post("/json", express.json(), (req, res) => {
    events.push(`handler /json scope=${scope.getStore()?.id} body=${JSON.stringify(req.body)}`);
    res.json(req.body);
});

let port = 0;
const server =
    process.argv[3] === "node-http" ? require("node:http").createServer(app).listen(0, run) : app.listen(0, run);

async function run() {
    port = server.address().port;
    for (const [method, path] of [
        ["GET", "/sync"],
        ["GET", "/async"],
        ["POST", "/json"],
        ["GET", "/missing"]
    ]) {
        events.length = 0;
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
            method,
            headers: method === "POST" ? { "content-type": "application/json" } : {},
            body: method === "POST" ? '{"a":1}' : undefined
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 20));
        console.log(method, path, res.status);
        console.log(events.map((e) => "  " + e).join("\n"));
    }
    process.exit(0);
}
