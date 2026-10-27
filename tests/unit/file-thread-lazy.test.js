// The file thread starts on the first small file read, not with the app: a thread is an isolate,
// 6.5 MB per process for an app that never serves a file.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("../../src/index.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-lazy-thread-"));
fs.writeFileSync(path.join(dir, "index.html"), "<p>hello</p>");

const app = express({ threads: 1 });
app.get("/json", (req, res) => res.json({ ok: true }));
app.use(express.static(dir));
const server = app.listen(0);

test.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * @param {string} target
 * @returns {Promise<{status: number, text: string}>}
 */
function request(target) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${/** @type {any} */ (app.address()).port}${target}`, (res) => {
            let text = "";
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        }).on("error", reject);
    });
}

test("no file thread until a small file is read, then one", async () => {
    assert.strictEqual(app.workers.length, 0, "none at construction and listen");
    const json = await request("/json");
    assert.strictEqual(json.text, '{"ok":true}');
    assert.strictEqual(app.workers.length, 0, "none for a route that reads no file");
    const file = await request("/index.html");
    assert.strictEqual(file.status, 200);
    assert.strictEqual(file.text, "<p>hello</p>");
    assert.strictEqual(app.workers.length, 1);
});
