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
    for (const command of ["migrate", "profile", "explain", "verify", "differences"]) {
        assert.match(out, new RegExp(`\\b${command}\\b`), command);
    }
});
