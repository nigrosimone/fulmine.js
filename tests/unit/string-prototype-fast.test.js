// A `class extends String` loaded by the app (ioredis has one) leaves String.prototype in dictionary
// mode, and with it every charCodeAt or slice in optimized code is a generic load. listen() repairs it.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("listen() leaves String.prototype in fast-properties mode", () => {
    const script = `
        const express = require(${JSON.stringify(path.join(__dirname, "..", "..", "src", "index.js"))});
        class Verbatim extends String {}
        const before = %HasFastProperties(String.prototype);
        const app = express();
        app.get("/a", (req, res) => res.send("a"));
        const server = app.listen(0, () => {
            process.stdout.write([before, %HasFastProperties(String.prototype)].join(" "));
            server.close();
        });
    `;
    const result = spawnSync(process.execPath, ["--allow-natives-syntax", "-e", script], { encoding: "utf8" });
    assert.strictEqual(result.status, 0, result.stderr);
    // false first: the class above did put it in dictionary mode, or the test proves nothing
    assert.strictEqual(result.stdout, "false true");
});

test("http.createServer(app) repairs it on the first request", () => {
    const script = `
        const http = require("http");
        const express = require(${JSON.stringify(path.join(__dirname, "..", "..", "src", "index.js"))});
        class Verbatim extends String {}
        const before = %HasFastProperties(String.prototype);
        const app = express();
        app.get("/a", (req, res) => res.send("a"));
        const server = http.createServer(app).listen(0, async () => {
            await fetch("http://127.0.0.1:" + server.address().port + "/a").then((r) => r.text());
            process.stdout.write([before, %HasFastProperties(String.prototype)].join(" "));
            server.close();
        });
    `;
    const result = spawnSync(process.execPath, ["--allow-natives-syntax", "-e", script], { encoding: "utf8" });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, "false true");
});
