// npx fulmine verify and npx fulmine explain, driven as a user drives them.
//
// Both are commands whose whole product is what they print, so these read the output. verify is
// run against fixtures rather than against this machine: what it says about Alpine has to be
// testable from a machine that is not Alpine.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const cli = path.join(__dirname, "../../src/cli.js");

/**
 * @param {string[]} args
 * @returns {{code: number, out: string}}
 */
function run(args) {
    try {
        return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }) };
    } catch (err) {
        const failure = /** @type {any} */ (err);
        return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
}

/**
 * @param {Record<string, string>} files
 * @returns {string} the directory holding them
 */
function fixture(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-cli-"));
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
    }
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("verify passes on a project with nothing in the way", () => {
    const dir = fixture({ "package.json": JSON.stringify({ dependencies: { helmet: "^8" } }) });
    const { code, out } = run(["verify", dir]);
    assert.strictEqual(code, 0);
    assert.match(out, /Node \d+\.\d+\.\d+/);
    assert.match(out, /µWebSockets\.js binary for/);
    assert.match(out, /Nothing in the way/);
});

test("verify fails on a musl base image, and says what to use instead", () => {
    const dir = fixture({ Dockerfile: "FROM node:20-alpine AS build\nRUN npm ci\n" });
    const { code, out } = run(["verify", dir]);
    assert.strictEqual(code, 1, "a base image that cannot run it is a failure");
    assert.match(out, /NO {4}Dockerfile: node:20-alpine/);
    assert.match(out, /musl, and there is no musl build/);
    assert.match(out, /node:22-trixie-slim/);
    assert.match(out, /1 thing\(s\) stop this from running/);
});

test("verify fails on a node older than the package needs", () => {
    const dir = fixture({ "Dockerfile.web": "FROM node:18-bookworm-slim\n" });
    const { code, out } = run(["verify", dir]);
    assert.strictEqual(code, 1);
    assert.match(out, /NO {4}Dockerfile\.web: node:18-bookworm-slim/);
    assert.match(out, /needs node 22 or newer/);
});

test("verify accepts a glibc image", () => {
    const dir = fixture({ Dockerfile: "FROM node:22-trixie-slim\n" });
    const { code, out } = run(["verify", dir]);
    assert.strictEqual(code, 0);
    assert.match(out, /ok {4}Dockerfile: node:22-trixie-slim/);
});

test("a dependency that needs a different API is a note, not a failure", () => {
    const dir = fixture({ "package.json": JSON.stringify({ dependencies: { "socket.io": "^4", ws: "^8" } }) });
    const { code, out } = run(["verify", dir]);
    assert.strictEqual(code, 0, "it runs; it just needs a different call");
    assert.match(out, /note {2}socket\.io needs a different API here/);
    assert.match(out, /io\.attachApp\(app\.uwsApp\)/);
    assert.match(out, /note {2}ws needs a different API here/);
    assert.match(out, /2 thing\(s\) worth reading/);
});

/** An application with one of each shape explain has something to say about. */
const APP = `
const express = require(${JSON.stringify(path.join(__dirname, "../../src/index.js"))});
const app = express();
function logger(req, res, next) { console.log(req.url); next(); }
app.use(logger);
app.get("/health", (req, res) => res.send("ok"));
app.get("/api/items/:id", (req, res) => res.json({ id: req.params.id }));
app.get(/^\\/legacy$/, (req, res) => res.send("legacy"));
app.listen(0);
`;

test("explain prints the plan for one route", () => {
    const dir = fixture({ "app.js": APP });
    const { code, out } = run(["explain", "/api/items/:id", path.join(dir, "app.js")]);
    assert.strictEqual(code, 0);
    assert.match(out, /GET \/api\/items\/:id/);
    assert.match(out, /route {6}native/);
    assert.match(out, /headers {4}(not )?copied/);
    assert.match(out, /query {6}/);
    assert.match(out, /chain {6}1 layer\(s\), 1 mounted layer\(s\) in front of it/);
    assert.match(out, /body {7}read for POST, PUT, PATCH and QUERY/);
});

test("explain names the method when asked to", () => {
    const dir = fixture({ "app.js": APP });
    const { code, out } = run(["explain", "GET /health", path.join(dir, "app.js")]);
    assert.strictEqual(code, 0);
    assert.match(out, /GET \/health/);
    assert.ok(!out.includes("/api/items"), "and explains only that one");
});

test("explain covers a prefix", () => {
    const dir = fixture({ "app.js": APP });
    const { out } = run(["explain", "/api*", path.join(dir, "app.js")]);
    assert.match(out, /GET \/api\/items\/:id/);
});

test("explain refuses a route that is not there", () => {
    const dir = fixture({ "app.js": APP });
    const { code, out } = run(["explain", "/nope", path.join(dir, "app.js")]);
    assert.strictEqual(code, 1);
    assert.match(out, /No route is registered as "\/nope"/);
});

test("explain says what to type when given nothing", () => {
    const { code, out } = run(["explain"]);
    assert.strictEqual(code, 1);
    assert.match(out, /Name the route to explain/);
});

test("the usage text lists every command", () => {
    const { out } = run([]);
    for (const command of ["migrate", "profile", "explain", "verify", "differences", "create", "pnpm"]) {
        assert.match(out, new RegExp(`\\b${command}\\b`), command);
    }
});

test("verify fails on a pnpm project, since pnpm 10.26 refuses a git dependency of a dependency", () => {
    const dir = fixture({ "package.json": "{}", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
    const { code, out } = run(["verify", dir]);
    assert.strictEqual(code, 1, "an install that fails stops everything after it");
    assert.match(out, /NO {4}pnpm \(pnpm-lock\.yaml is here\) will refuse to install this/);
    assert.match(out, /ERR_PNPM_EXOTIC_SUBDEP/);
    assert.match(out, /npx fulmine.js pnpm/);
});

test("verify accepts the two lines `npx fulmine.js pnpm` writes, and notices a pin that differs", () => {
    const { UWS_SPEC } = require("../../src/adopt.js");
    const override = 'overrides:\n  "fulmine.js>uWebSockets.js": "-"\n';
    const fixed = fixture({
        "package.json": JSON.stringify({ dependencies: { "uWebSockets.js": UWS_SPEC } }),
        "pnpm-lock.yaml": "",
        "pnpm-workspace.yaml": override
    });
    assert.match(
        run(["verify", fixed]).out,
        /ok {4}pnpm, with µWebSockets.js as the project's own dependency at the pin/
    );

    const stale = fixture({
        "package.json": JSON.stringify({
            dependencies: { "uWebSockets.js": "github:uNetworking/uWebSockets.js#v20.60.0" }
        }),
        "pnpm-lock.yaml": "",
        "pnpm-workspace.yaml": override
    });
    const noted = run(["verify", stale]);
    assert.strictEqual(noted.code, 0, "an older pin installs, it is a note");
    assert.match(noted.out, /note {2}pnpm, with µWebSockets.js as the project's own dependency at github:.*v20.60.0/);

    const dropped = fixture({ "package.json": "{}", "pnpm-lock.yaml": "", "pnpm-workspace.yaml": override });
    const refused = run(["verify", dropped]);
    assert.strictEqual(refused.code, 1, "the override alone leaves nothing to install it");
    assert.match(refused.out, /NO {4}pnpm-workspace.yaml drops µWebSockets.js/);
});

test("verify accepts pnpm when the setting is off, the version is older, or µWebSockets.js comes from a registry", () => {
    const off = fixture({
        "package.json": "{}",
        "pnpm-lock.yaml": "",
        "pnpm-workspace.yaml": "packages:\n  - apps/*\nblockExoticSubdeps: false\n"
    });
    assert.match(run(["verify", off]).out, /ok {4}pnpm, with blockExoticSubdeps off/);

    const older = fixture({ "package.json": JSON.stringify({ packageManager: "pnpm@10.20.0" }) });
    assert.match(run(["verify", older]).out, /ok {4}pnpm 10\.20 installs a git dependency of a dependency/);

    const registry = fixture({
        "package.json": JSON.stringify({ packageManager: "pnpm@11.0.0" }),
        "pnpm-workspace.yaml": "overrides:\n  uWebSockets.js: 20.69.0\n"
    });
    assert.match(run(["verify", registry]).out, /ok {4}pnpm, with µWebSockets\.js overridden to 20\.69\.0/);
});
