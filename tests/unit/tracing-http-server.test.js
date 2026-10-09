// node:http's server channels on µWS: what fulmine publishes when app.listen() serves the app has to
// be what node itself publishes when http.createServer(app) does, see tracing-http-server.app.js

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const app = path.join(__dirname, "tracing-http-server.app.js");
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

test("on µWS the channels say what node's http says, and the request runs inside server.emit", () => {
    const nodeHttp = run("node-http");
    // the reference has to be one, or the comparison says nothing
    assert.match(nodeHttp, /handler \/async scope=2/);
    assert.match(nodeHttp, /finish GET \/missing 404/);
    assert.strictEqual(run(), nodeHttp);
});
