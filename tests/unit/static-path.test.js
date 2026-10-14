// a file asked for as it is gets joined to the root once, in express.static: sendFile takes that
// path and does not resolve it again

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("../../src/index.js");

test("a plain express.static request calls path.resolve zero times", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-static-path-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "a.txt"), "hello");

    const app = express();
    app.use("/f", express.static(dir));
    await new Promise((resolve) => app.listen(0, () => resolve(undefined)));
    t.after(() => app.close());
    const url = `http://127.0.0.1:${app.address().port}/f/a.txt`;
    assert.strictEqual(await fetch(url).then((r) => r.text()), "hello");

    const real = path.resolve;
    let calls = 0;
    path.resolve = (...args) => (calls++, real(...args));
    try {
        assert.strictEqual(await fetch(url).then((r) => r.text()), "hello");
    } finally {
        path.resolve = real;
    }
    assert.strictEqual(calls, 0);
});
