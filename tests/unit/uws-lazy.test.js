// µWS is loaded when an app first needs it, not when the package is required. Angular's build
// imports server.ts in a worker thread and serves it through node's http, and on Windows the
// binary crashes the process when a thread that loaded it exits (uNetworking/uWebSockets.js#668),
// so that path has to get through without ever loading it.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");

const uwsLoaded = () =>
    Object.keys(require.cache).some((file) => file.includes(path.join("node_modules", "uWebSockets.js")));

test("an app served through node's http never loads µWS", async () => {
    const express = require("../../src/index.js");
    assert.strictEqual(uwsLoaded(), false, "required");

    const app = express();
    app.get("/", (req, res) => res.send("hi"));
    assert.strictEqual(uwsLoaded(), false, "built");

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, () => resolve(undefined)));
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    const answer = await fetch(`http://127.0.0.1:${port}/`);
    assert.strictEqual(await answer.text(), "hi");
    server.close();
    assert.strictEqual(uwsLoaded(), false, "served through node");
});
