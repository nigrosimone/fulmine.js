// The checks behind npx fulmine verify, one at a time.
//
// The answers that matter are the ones this machine cannot produce: musl, a glibc too old, a node
// ABI the pinned build has no binary for. Each check takes what it judges as an argument for
// exactly that reason, so an Alpine answer is testable from a machine that is not Alpine.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkNode, checkLibc, checkBinary, checkDockerfiles, checkDependencies } = require("../../src/verify.js");

test("the node version is read against what the package asks for", () => {
    assert.strictEqual(checkNode("22.0.0", ">=22").level, "ok");
    assert.strictEqual(checkNode("26.3.0", ">=22").level, "ok");
    // 9 is not 22, which a string comparison would get wrong
    assert.strictEqual(checkNode("9.11.2", ">=22").level, "no");
    const old = checkNode("20.19.0", ">=22");
    assert.strictEqual(old.level, "no");
    assert.match(old.what, /Node 20\.19\.0/);
    assert.match(old.detail, /needs >=22/);
});

test("the C library question only arises on linux", () => {
    assert.strictEqual(checkLibc("win32", undefined), undefined);
    assert.strictEqual(checkLibc("darwin", undefined), undefined);
});

test("musl is a failure that names the way out", () => {
    const musl = checkLibc("linux", undefined);
    assert.strictEqual(musl.level, "no");
    assert.match(musl.what, /musl libc/);
    assert.match(musl.detail, /Alpine/);
    assert.match(musl.detail, /node:22-trixie-slim/);
    assert.match(musl.detail, /There is no musl build/);
});

test("a glibc older than the binaries were built against is a failure", () => {
    assert.strictEqual(checkLibc("linux", "2.31").level, "no");
    assert.match(checkLibc("linux", "2.31").detail, /need 2\.38 or newer/);
    assert.strictEqual(checkLibc("linux", "2.38").level, "ok");
    assert.strictEqual(checkLibc("linux", "2.39").level, "ok");
    assert.strictEqual(checkLibc("linux", "3.0").level, "ok");
});

test("the binary for this machine is found and loads", () => {
    const here = checkBinary();
    assert.strictEqual(here.level, "ok");
    assert.match(here.what, new RegExp(`${process.platform} ${process.arch}, node ABI ${process.versions.modules}`));
});

test("a node ABI the build has no binary for says which ones it has", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-abi-"));
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "uws_linux_x64_127.node"), "");
    fs.writeFileSync(path.join(dir, "uws_linux_x64_137.node"), "");

    const answer = checkBinary("linux", "x64", "131", dir);
    assert.strictEqual(answer.level, "no");
    assert.match(answer.what, /no µWebSockets\.js binary for node ABI 131/);
    assert.match(answer.detail, /ships ABI 127, 137/);
    assert.match(answer.detail, /node 22, 24/, "and says which node releases those are");
});

test("a platform the build does not ship says so instead", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-platform-"));
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "uws_linux_x64_127.node"), "");

    const answer = checkBinary("freebsd", "x64", "127", dir);
    assert.strictEqual(answer.level, "no");
    assert.match(answer.what, /no µWebSockets\.js binary for freebsd x64/);
    assert.match(answer.detail, /Linux, macOS and Windows/);
});

test("an ABI nobody here knows is reported as itself", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-abi2-"));
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "uws_linux_x64_999.node"), "");
    const answer = checkBinary("linux", "x64", "127", dir);
    assert.match(answer.detail, /ABI 999/, "an unknown ABI is not guessed at");
});

/**
 * @param {Record<string, string>} files
 * @returns {string}
 */
function fixture(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-verify-"));
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
    }
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("every FROM in every Dockerfile is judged", () => {
    const dir = fixture({
        Dockerfile: "FROM node:22-trixie-slim AS build\nRUN npm ci\nFROM node:20-alpine\n",
        "Dockerfile.worker": "  from node:18-bookworm-slim\n",
        "not-a-dockerfile.txt": "FROM node:20-alpine\n"
    });
    const results = checkDockerfiles(dir);
    assert.strictEqual(results.length, 3, "two files, three FROM lines, and the txt is not read");
    assert.deepStrictEqual(
        results.map((entry) => entry.level),
        ["ok", "no", "no"]
    );
    assert.match(results[1].what, /node:20-alpine/);
    assert.match(results[2].what, /Dockerfile\.worker: node:18-bookworm-slim/, "FROM is matched whatever its case");
});

test("a directory with no Dockerfile has nothing to say", () => {
    assert.deepStrictEqual(checkDockerfiles(fixture({})), []);
    assert.deepStrictEqual(checkDockerfiles(path.join(os.tmpdir(), "fulmine-does-not-exist")), []);
});

test("dependencies are read from package.json, both kinds", () => {
    const dir = fixture({
        "package.json": JSON.stringify({ dependencies: { ws: "^8" }, devDependencies: { spdy: "^4", helmet: "^8" } })
    });
    const results = checkDependencies(dir);
    assert.deepStrictEqual(
        results.map((entry) => entry.what),
        ["ws needs a different API here", "spdy needs a different API here"]
    );
    assert.ok(
        results.every((entry) => entry.level === "note"),
        "none of them stops the start"
    );
});

test("a project without a package.json, or with one that will not parse, is not a failure", () => {
    assert.deepStrictEqual(checkDependencies(fixture({})), []);
    assert.deepStrictEqual(checkDependencies(fixture({ "package.json": "{ not json" })), []);
});
