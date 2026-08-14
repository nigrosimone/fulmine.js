// "stat cache", which is the one setting here that can answer with a file as it was a moment ago.
// What it must never do is hold on past its window, so both halves are pinned: the syscall it
// saves, and the edit it must not hide for longer than it was told.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const express = require("../../src/index.js");

/** counts the stats a body of work performs, wrapping the namespace the way a mock would */
function countingStats(work) {
    const real = fs.statSync;
    let count = 0;
    fs.statSync = function (...args) {
        count++;
        return real.apply(this, args);
    };
    return Promise.resolve(work()).then(
        (value) => ((fs.statSync = real), { count, value }),
        (err) => {
            fs.statSync = real;
            throw err;
        }
    );
}

/** an app serving one directory, listening on a port the OS picked */
function serve(t, dir, window) {
    const app = express();
    if (window !== undefined) {
        app.set("stat cache", window);
    }
    app.use("/f", express.static(dir));
    return new Promise((resolve) => {
        app.listen(0, () => {
            t.after(() => app.close());
            resolve({ app, port: app.address().port });
        });
    });
}

test("a window answers from the remembered stat, and without one every request asks the disk", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-stat-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "a.txt"), "first");

    const cached = await serve(t, dir, "1s");
    const withWindow = await countingStats(async () => {
        for (let i = 0; i < 5; i++) {
            await fetch(`http://127.0.0.1:${cached.port}/f/a.txt`).then((r) => r.text());
        }
    });

    const plain = await serve(t, dir);
    const without = await countingStats(async () => {
        for (let i = 0; i < 5; i++) {
            await fetch(`http://127.0.0.1:${plain.port}/f/a.txt`).then((r) => r.text());
        }
    });

    assert.strictEqual(withWindow.count, 1, "one stat for the five requests");
    assert.strictEqual(without.count, 5, "one stat each without a window");
});

test("what the window costs is an edit hidden for its length, and no longer", async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-stat-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "b.txt");
    fs.writeFileSync(file, "first");

    const { port } = await serve(t, dir, 150);
    const read = () => fetch(`http://127.0.0.1:${port}/f/b.txt`).then((r) => r.text());

    assert.strictEqual(await read(), "first");
    fs.writeFileSync(file, "second, which is longer");
    // still the length the stat remembered, which is the trade the setting is
    assert.strictEqual(await read(), "first");

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(await read(), "second, which is longer");
});
