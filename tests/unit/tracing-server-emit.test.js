// A tracer that wraps http.Server.prototype.emit (OpenTelemetry's HTTP instrumentation) on µWS: the
// request has to go through the wrapper as it does on node's http, see tracing-server-emit.app.js

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const app = path.join(__dirname, "tracing-server-emit.app.js");
const fulmine = path.join(__dirname, "..", "..", "src", "index.js");

/**
 * @param {string[]} args
 * @returns {string}
 */
const run = (...args) => {
    const out = spawnSync(process.execPath, [app, fulmine, ...args], { encoding: "utf8", timeout: 60000 });
    assert.strictEqual(out.status, 0, out.stderr);
    return out.stdout.replace(/\r/g, "");
};

test("on µWS a request goes through a wrapped http.Server.prototype.emit, as on node's http", () => {
    const nodeHttp = run("node-http");
    // the reference has to be one, or the comparison says nothing
    assert.match(nodeHttp, /handler \/async scope=2/);
    assert.match(nodeHttp, /close \/missing 404/);
    assert.strictEqual(run(), nodeHttp);
});
