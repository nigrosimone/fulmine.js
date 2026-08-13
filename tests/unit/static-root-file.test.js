// express.static() mounted on a single file, and the trailing separator that decides whether it
// can be served at all.
//
// path.join keeps a trailing separator, path.resolve takes it off, and the url under a mount that
// matched the whole path is "/". Join them and the disk is asked for "file.txt/", which linux
// refuses because a file is not a directory and Windows serves anyway. There is a differential test
// for this too, but it can only see the failure on linux: what is checked here is the path itself,
// so the machine writing the code sees it as well.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const express = require("../../src/index.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-root-file-"));
fs.writeFileSync(path.join(dir, "file.txt"), "hello");

const app = express();
app.use("/file.txt", express.static(path.join(dir, "file.txt")));
app.use((req, res) => res.status(404).send("404"));
const server = app.listen(0);

test.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

/** @type {string[]} */
const statted = [];
const realStatSync = fs.statSync;
// the middleware reads fs.statSync off the module object on every call, so this sees every path it
// asks about without touching the middleware itself
// @ts-expect-error the spy takes what the real one takes
fs.statSync = (target, ...rest) => {
    statted.push(String(target));
    return realStatSync(target, ...rest);
};
test.after(() => {
    fs.statSync = realStatSync;
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

test("a file as root is served, and the disk is not asked for it as a directory", async () => {
    statted.length = 0;
    const answer = await request("/file.txt");
    assert.strictEqual(answer.status, 200);
    assert.strictEqual(answer.text, "hello");
    assert.deepStrictEqual(
        statted.filter((target) => target.endsWith(path.sep)),
        [],
        "a trailing separator here is the linux failure, and Windows would have served it regardless"
    );
});

test("the same file asked for with a trailing slash is not there", async () => {
    const answer = await request("/file.txt/");
    assert.strictEqual(answer.status, 404);
    assert.strictEqual(answer.text, "404");
});
