// The warning for a uWebSockets.js that is not the one this package pins.
//
// A pnpm project owns that dependency itself, so it can move without this package moving, and
// the mismatch is said once, when uWebSockets.js is loaded: an app served through node's http
// never loads it. The other version is faked by resolving the module name to a copy whose
// package.json or source_commit says something else, since installing two is not a test.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const index = path.join(__dirname, "../../src/index.js");
const uws = path.join(__dirname, "../../src/uws.js");
const real = require.resolve("uWebSockets.js");
const tag = { spec: "github:uNetworking/uWebSockets.js#v20.71.0" };
const commit = {
    spec: `github:uNetworking/uWebSockets.js#${"a".repeat(40)}`,
    source: "b".repeat(40)
};

/**
 * Runs code with the given installed metadata and expected pin, and returns stderr.
 *
 * @param {{version?: string, source?: string, pin?: {spec: string, source?: string}}} metadata
 * @param {string} code
 * @returns {string}
 */
function stderrWith({ version, source, pin = tag }, code) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-uws-"));
    fs.writeFileSync(path.join(dir, "uws.js"), `module.exports = require(${JSON.stringify(real)});`);
    fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({ name: "uWebSockets.js", version, main: "uws.js" })
    );
    if (source !== undefined) fs.writeFileSync(path.join(dir, "source_commit"), source);
    const preload = path.join(dir, "preload.js");
    fs.writeFileSync(
        preload,
        `const Module = require("module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === "uWebSockets.js" ? ${JSON.stringify(path.join(dir, "uws.js"))} : resolve.call(this, request, ...rest);
};
const load = Module._load;
Module._load = function (request, parent, ...rest) {
    if (request === "../package.json" && parent.filename === ${JSON.stringify(uws)}) {
        return ${JSON.stringify({ dependencies: { "uWebSockets.js": pin.spec }, uwsSourceCommit: pin.source })};
    }
    return load.call(this, request, parent, ...rest);
};`
    );
    const run = spawnSync(process.execPath, ["-r", preload, "-e", code], {
        encoding: "utf8"
    });
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(run.status, 0, run.stderr);
    return run.stderr;
}

const required = `require(${JSON.stringify(index)});`;
// loaded twice, as listen() and a second app would
const loaded = `${required} require(${JSON.stringify(uws)}).loadUWS(); require(${JSON.stringify(uws)}).loadUWS();`;

test("a uWebSockets.js other than the pinned one is named once, when it is loaded", () => {
    const stderr = stderrWith({ version: "20.1.0" }, loaded);
    assert.match(stderr, /uWebSockets\.js 20\.1\.0 is installed, this version was tested with \d+\.\d+\.\d+/);
    assert.match(stderr, /npx fulmine\.js pnpm/);
    assert.strictEqual(stderr.split("is installed").length, 2);
});

test("requiring the package is silent: an app served through node's http never loads it", () => {
    assert.strictEqual(stderrWith({ version: "20.1.0" }, required), "");
    assert.strictEqual(stderrWith({ version: "20.71.0", source: "c".repeat(40), pin: commit }, required), "");
});

test("the pinned one is silent", () => {
    assert.strictEqual(stderrWith({ version: "20.71.0" }, loaded), "");
});

test("a different source at the same version is named once for a commit pin", () => {
    const source = "c".repeat(40);
    const stderr = stderrWith({ version: "20.71.0", source, pin: commit }, loaded);
    assert.ok(stderr.includes(`uWebSockets.js 20.71.0 (source ${source}) is installed`));
    assert.ok(stderr.includes(`this version was tested with source ${commit.source}`));
    assert.match(stderr, /npx fulmine\.js pnpm/);
    assert.strictEqual(stderr.split("is installed").length, 2);
});

test("the pinned source is silent even when its marker ends in a newline", () => {
    assert.strictEqual(stderrWith({ version: "20.71.0", source: `${commit.source}\n`, pin: commit }, loaded), "");
});

test("a missing source marker is silent when there is nothing to compare", () => {
    assert.strictEqual(stderrWith({ version: "20.71.0", pin: commit }, loaded), "");
});

test("a release tag uses its version even when source metadata is present", () => {
    const pin = { ...tag, source: commit.source };
    assert.strictEqual(stderrWith({ version: "20.71.0", source: "c".repeat(40), pin }, loaded), "");
});
