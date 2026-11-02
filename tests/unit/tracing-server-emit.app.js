// The app of tracing-server-emit.test.js: a tracer that wraps http.Server.prototype.emit, as
// OpenTelemetry's HTTP instrumentation does, and reads no channel.
// node tracing-server-emit.app.js <express module> [node-http]
// Through http.createServer(app) node calls the wrapper; on µWS fulmine has to, and the output has
// to be the same.

const http = require("node:http");
const { AsyncLocalStorage } = require("node:async_hooks");
const express = require(process.argv[2]);

const scope = new AsyncLocalStorage();
/** @type {string[]} */
const events = [];
let ids = 0;

const original = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, ...args) {
    if (event !== "request") {
        return original.apply(this, [event, ...args]);
    }
    const [request, response] = args;
    events.push(`wrapper ${request.method} ${request.url} socket=${typeof request.socket.remoteAddress}`);
    response.on("close", () => events.push(`close ${request.url} ${response.statusCode}`));
    return scope.run({ id: ++ids }, () => original.apply(this, [event, ...args]));
};

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

const server = process.argv[3] === "node-http" ? http.createServer(app).listen(0, run) : app.listen(0, run);

async function run() {
    const port = server.address().port;
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
