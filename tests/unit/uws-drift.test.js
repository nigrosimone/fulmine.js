// The warning for a uWebSockets.js that is not the one this package pins.
//
// A pnpm project owns that dependency itself, so it can move without this package moving, and
// the mismatch is said once at require time. The other version is faked by resolving the module
// name to a copy whose package.json says something else, since installing two is not a test.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const index = path.join(__dirname, "../../src/index.js");
const real = path.dirname(require.resolve("uWebSockets.js"));

/**
 * Requires the package with uWebSockets.js answering as the given version, and returns stderr.
 *
 * @param {string} version
 * @returns {string}
 */
function stderrWith(version) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-uws-"));
    fs.writeFileSync(
        path.join(dir, "uws.js"),
        `module.exports = require(${JSON.stringify(path.join(real, "uws.js"))});`
    );
    fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "uWebSockets.js", version, main: "uws.js" })
    );
    const preload = path.join(dir, "preload.js");
    fs.writeFileSync(
        preload,
        `const Module = require("module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === "uWebSockets.js" ? ${JSON.stringify(path.join(dir, "uws.js"))} : resolve.call(this, request, ...rest);
};`
    );
    const run = spawnSync(process.execPath, ["-r", preload, "-e", `require(${JSON.stringify(index)})`], {
        encoding: "utf8"
    });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(run.status, 0, run.stderr);
    return run.stderr;
}

const pinned = /#v?([\d.]+)$/.exec(require("../../package.json").dependencies["uWebSockets.js"])?.[1] ?? "";

test("a uWebSockets.js other than the pinned one is named once at require time", () => {
    const stderr = stderrWith("20.1.0");
    assert.match(stderr, /uWebSockets\.js 20\.1\.0 is installed, this version was tested with \d+\.\d+\.\d+/);
    assert.match(stderr, /npx fulmine\.js pnpm/);
});

test("the pinned one is silent", () => {
    assert.strictEqual(stderrWith(pinned), "");
});
