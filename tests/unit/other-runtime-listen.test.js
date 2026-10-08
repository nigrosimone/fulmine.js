// On Bun and Deno µWS does not load, so listen() serves through their node:http. Run on node with
// process.versions.bun set before the require, which is all src/uws.js looks at: the app answers,
// reports its address, hands a busy port to the callback, closes, says why a websocket route cannot
// be served, and never loads uWebSockets.js.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SOURCE = path.join(__dirname, "..", "..", "src", "index.js");

const script = `
Object.defineProperty(process.versions, "bun", { value: "1.4.2", enumerable: true });
const express = require(${JSON.stringify(SOURCE)});
const app = express();
app.get("/", (req, res) => res.json({ hello: "world" }));
const lines = [];
const server = app.listen(0, "127.0.0.1", async () => {
    lines.push("same server " + (server === app));
    lines.push("port " + (app.address().port === app.port));
    const response = await fetch("http://127.0.0.1:" + app.port + "/");
    lines.push(response.status + " " + (await response.text()));
    express().listen(app.port, "127.0.0.1", (err) => {
        lines.push("busy " + (err && err.code));
        const ws = express();
        ws.ws("/live", { message() {} });
        try {
            ws.listen(0);
        } catch (err) {
            lines.push("ws " + /does not load on Bun/.test(err.message));
        }
        app.close((err) => {
            lines.push("closed " + (err === undefined) + " " + app.address());
            lines.push("uws loaded " + Object.keys(require.cache).some((key) => key.includes("uWebSockets.js")));
            process.stdout.write(lines.join("\\n"), () => process.exit(0));
        });
    });
});
`;

test("listen() on Bun and Deno serves through node:http and never loads µWS", () => {
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30000 });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(
        result.stdout,
        [
            "same server true",
            "port true",
            '200 {"hello":"world"}',
            "busy EADDRINUSE",
            "ws true",
            "closed true null",
            "uws loaded false"
        ].join("\n")
    );
});
