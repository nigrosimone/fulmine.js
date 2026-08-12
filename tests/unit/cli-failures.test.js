// What the commands say when they cannot do what was asked.
//
// Each of these is a message somebody reads at the moment they are already confused, so the point
// of the test is the wording as much as the exit code.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const cli = path.join(__dirname, "../../src/cli.js");
const src = path.join(__dirname, "../../src/index.js");

/**
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {{code: number, out: string}}
 */
function run(args, cwd) {
    try {
        return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd }) };
    } catch (err) {
        const failure = /** @type {any} */ (err);
        return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
}

/**
 * @param {Record<string, string>} files
 * @returns {string}
 */
function fixture(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-cli-fail-"));
    for (const [name, content] of Object.entries(files)) {
        const full = path.join(dir, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("migrate refuses a path that is not there", () => {
    const { code, out } = run(["migrate", path.join(os.tmpdir(), "fulmine-not-here")]);
    assert.strictEqual(code, 1);
    assert.match(out, /does not exist/);
});

test("an unknown command prints the usage and fails", () => {
    const { code, out } = run(["dance"]);
    assert.strictEqual(code, 1);
    assert.match(out, /Usage:/);
});

test("profile says where to point it when it finds nothing to load", () => {
    const dir = fixture({ "readme.txt": "no application here" });
    const { code, out } = run(["profile"], dir);
    assert.strictEqual(code, 1);
    assert.match(out, /Nothing to profile/);
    assert.match(out, /package\.json main/);
});

test("profile reports a file that throws while it is loading", () => {
    const dir = fixture({ "app.js": "throw new Error('broken at import');\n" });
    const { code, out } = run(["profile", path.join(dir, "app.js")]);
    assert.strictEqual(code, 1);
    assert.match(out, /could not be loaded/);
    assert.match(out, /broken at import/);
});

test("profile says so when a file builds no application", () => {
    const dir = fixture({ "app.js": "module.exports = { not: 'an app' };\n" });
    const { code, out } = run(["profile", path.join(dir, "app.js")]);
    assert.strictEqual(code, 1);
    assert.match(out, /built no application/);
    assert.match(out, /neither called listen\(\) nor/);
});

test("an application that exports itself instead of listening is profiled all the same", () => {
    const dir = fixture({
        "app.js": `const express = require(${JSON.stringify(src)});
const app = express();
app.get("/exported", (req, res) => res.send("ok"));
module.exports = app;
`
    });
    const { code, out } = run(["profile", path.join(dir, "app.js")]);
    assert.strictEqual(code, 0);
    assert.match(out, /\/exported/);
    assert.match(out, /µWS/);
});

test("profile prints a heading per application when a file builds several", () => {
    const dir = fixture({
        "app.js": `const express = require(${JSON.stringify(src)});
for (const port of [0, 0]) {
    const app = express();
    app.get("/twin", (req, res) => res.send("ok"));
    app.listen(port);
}
`
    });
    const { code, out } = run(["profile", path.join(dir, "app.js")]);
    assert.strictEqual(code, 0);
    assert.strictEqual(out.match(/=== an application listening on/g)?.length, 2);
});

test("profile names the mounted routers the compiler could not walk into", () => {
    const dir = fixture({
        "app.js": `const express = require(${JSON.stringify(src)});
const app = express();
const router = express.Router();
router.get("/inside", (req, res) => res.send("ok"));
// a mount whose path is a regular expression is not one the compiler can follow
app.use(/^\\/dynamic/, router);
app.listen(0);
`
    });
    const { code, out } = run(["profile", path.join(dir, "app.js")]);
    assert.strictEqual(code, 0);
    assert.match(out, /mounted router\(s\) the compiler did not walk into/);
});

test("explain says where to point it when there is nothing to load", () => {
    const dir = fixture({ "readme.txt": "nothing" });
    const { code, out } = run(["explain", "/anything"], dir);
    assert.strictEqual(code, 1);
    assert.match(out, /Nothing to explain/);
});

test("migrate leaves TypeScript alone when the project has no compiler", () => {
    // resolved from the project being migrated and from the working directory, and this fixture is
    // outside any node_modules, so there is none to find
    const dir = fixture({ "server.ts": 'import express from "express";\nexport default express();\n' });
    const { code, out } = run(["migrate", "--dry-run", dir], dir);
    assert.strictEqual(code, 0);
    assert.match(out, /TypeScript file\(s\) were left alone/);
    assert.match(out, /server\.ts/);
    assert.match(out, /Install it and run this again/);
});
