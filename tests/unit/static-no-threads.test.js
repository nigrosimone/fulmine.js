// A small file with `threads: 0`, what one core gets by default: read whole and cached as with a file
// thread. Piped instead, Actual's index.html took 4.5x the CPU of the threaded path.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("../../src/index.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-no-threads-"));
fs.writeFileSync(path.join(dir, "index.html"), "<p>hello</p>");

const app = express({ threads: 0 });
app.use(express.static(dir));
const server = app.listen(0);

// both read fs off the module object on every call, so the spies see every file opened
let streams = 0;
let reads = 0;
const realCreateReadStream = fs.createReadStream;
const realReadFile = fs.promises.readFile;
// @ts-expect-error the spy takes what the real one takes
fs.createReadStream = (...args) => (streams++, realCreateReadStream(...args));
// @ts-expect-error the spy takes what the real one takes
fs.promises.readFile = (...args) => (reads++, realReadFile(...args));

test.after(() => {
    fs.createReadStream = realCreateReadStream;
    fs.promises.readFile = realReadFile;
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

test("with no file thread a small file is read whole once, then served from the cache", async () => {
    assert.strictEqual(app.workers.length, 0);
    for (let i = 0; i < 3; i++) {
        const answer = await request("/index.html");
        assert.strictEqual(answer.status, 200);
        assert.strictEqual(answer.text, "<p>hello</p>");
    }
    assert.strictEqual(streams, 0, "not piped");
    assert.strictEqual(reads, 1, "the disk once, the cache after");
});
