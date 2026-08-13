// `npx fulmine profile`, which prints what listen() worked out about each route.
//
// It loads somebody's application, so the two things worth pinning are that it loads it without
// letting it listen, and that what it prints follows from what the compiler decided rather than
// from the shape of the file it was pointed at.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findEntry, collectRoutes, profile } = require("../../src/cli.js");
const express = require("../../src/index.js");

const SRC = path.resolve(__dirname, "..", "..", "src", "index.js").replace(/\\/g, "/");

/** a directory with the given files in it, removed when the test ends */
function scratch(t, files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-cli-"));
    for (const [name, contents] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), contents, "utf8");
    }
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** what the command printed, and what it answered */
function run(args) {
    const lines = [];
    const realLog = console.log;
    const realError = console.error;
    console.log = (...parts) => lines.push(parts.join(" "));
    console.error = (...parts) => lines.push(parts.join(" "));
    try {
        const code = profile(args);
        return { code, out: lines.join("\n") };
    } finally {
        console.log = realLog;
        console.error = realError;
    }
}

const APP = (extra = "") => `
const express = require(${JSON.stringify(SRC)});
const app = express();
app.set("etag", false);
const api = express.Router();
api.get("/health", (req, res) => res.send("ok"));
api.get("/users/:id", (req, res) => res.json({ id: req.params.id }));
app.use("/api", api);
app.get("/hello", (req, res) => res.send("Hello World!"));
app.get("/:anything", (req, res) => res.send("catch all"));
app.get("/after-the-param", (req, res) => res.send("shadowed"));
${extra}
`;

test("the entry is the one named, or the one package.json points at, or a usual name", (t) => {
    const dir = scratch(t, {
        "package.json": JSON.stringify({ main: "lib/entry.js" }),
        "lib/entry.js": "",
        "server.js": ""
    });
    // back out of the directory before anything tries to remove it: windows will not remove the
    // directory a process is sitting in, and the failure is the cleanup rather than the test
    const cwd = process.cwd();
    process.chdir(dir);
    try {
        assert.strictEqual(findEntry("server.js"), path.resolve(dir, "server.js"));
        // main wins over the usual names when nothing was named
        assert.strictEqual(findEntry(undefined), path.resolve(dir, "lib", "entry.js"));
        assert.strictEqual(findEntry("nowhere.js"), null);

        fs.rmSync(path.join(dir, "package.json"));
        assert.strictEqual(findEntry(undefined), path.resolve(dir, "server.js"));
    } finally {
        process.chdir(cwd);
    }
});

test("the start script names the entry when main does not, or names one nobody built", (t) => {
    const dir = scratch(t, {
        // a TypeScript project before its build, and a service whose entry is where only the
        // start script knows to look: neither is covered by main or by the usual names
        "package.json": JSON.stringify({
            main: "dist/server.js",
            scripts: { start: "node --env-file=.env src/api/server.js" }
        }),
        "src/api/server.js": "",
        "bin/www": ""
    });
    const cwd = process.cwd();
    process.chdir(dir);
    try {
        assert.strictEqual(findEntry(undefined), path.resolve(dir, "src", "api", "server.js"));

        // what the start script runs has to be a file node runs: a wrapper runs something else
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { start: "nodemon bin/www" } }));
        assert.strictEqual(findEntry(undefined), null);

        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { start: "node ./bin/www" } }));
        assert.strictEqual(findEntry(undefined), path.resolve(dir, "bin", "www"));
    } finally {
        process.chdir(cwd);
    }
});

test("every route is collected, through the routers mounted under it", () => {
    const app = express();
    const api = express.Router();
    api.get("/health", (req, res) => res.send("ok"));
    app.use("/api", api);
    app.get("/hello", (req, res) => res.send("hi"));

    const paths = collectRoutes(app, "").map(({ full }) => full);
    assert.ok(paths.includes("/api/health"), "a route inside a mounted router");
    assert.ok(paths.includes("/hello"));
    assert.ok(paths.includes("/api"), "and the mount itself");
});

test("an application that listens is loaded without listening", (t) => {
    const dir = scratch(t, { "server.js": APP('app.listen(3000, () => console.log("MUST NOT RUN"));') });
    const { code, out } = run([path.join(dir, "server.js")]);

    assert.strictEqual(code, 0);
    assert.doesNotMatch(out, /MUST NOT RUN/, "the listen callback must not run");
    assert.match(out, /The server was not started/);
    assert.match(out, /route\(s\), \d+ answered by µWS itself/);
});

test("what it prints follows the compiler's decisions", (t) => {
    const dir = scratch(t, { "server.js": APP("app.listen(3000);") });
    const { out } = run([path.join(dir, "server.js")]);

    // a literal inside a mounted router is matched by µWS with its whole path
    assert.match(out, /GET\s+\/api\/health\s+µWS\s+\/api\/health/);
    // and one written after a parameter route is not, with the reason and the advice
    assert.match(out, /\/after-the-param\s+router: the parameter route \/:anything is written before it/);
    assert.match(out, /write it above \/:anything/);
    assert.match(out, /What this adds up to/);
    assert.match(out, /layers in front of a compiled handler/);
});

test("an application that exports itself instead of listening is compiled anyway", (t) => {
    const dir = scratch(t, { "server.js": APP("module.exports = app;") });
    const { code, out } = run([path.join(dir, "server.js")]);
    assert.strictEqual(code, 0);
    assert.match(out, /GET\s+\/hello\s+µWS/);
});

test("a file that builds nothing, or will not load, says so and fails", (t) => {
    const dir = scratch(t, {
        "empty.js": "module.exports = { notAnApp: true };",
        "broken.js": "throw new Error('boom');"
    });

    const nothing = run([path.join(dir, "empty.js")]);
    assert.strictEqual(nothing.code, 1);
    assert.match(nothing.out, /built no application/);

    const broken = run([path.join(dir, "broken.js")]);
    assert.strictEqual(broken.code, 1);
    assert.match(broken.out, /could not be loaded/);
    assert.match(broken.out, /boom/);

    const missing = run([path.join(dir, "nowhere.js")]);
    assert.strictEqual(missing.code, 1);
    assert.match(missing.out, /Nothing to profile/);
});

test("an application on a second copy of the library is stubbed too, rather than left to listen", (t) => {
    // The command runs from its own copy and the application loads whichever one resolves from its
    // own directory. A global install, an npx of a pinned version or a hoisted workspace leaves two
    // on disk, and stubbing only this one lets the application's real listen() bind the port, after
    // which the command reports that the file built nothing. The copy is made inside the repository
    // so that its own dependencies still resolve upward.
    const root = fs.mkdtempSync(path.join(path.resolve(__dirname, ".."), ".copy-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const copy = path.join(root, "node_modules", "fulmine.js");
    fs.mkdirSync(copy, { recursive: true });
    fs.cpSync(path.resolve(__dirname, "..", "..", "src"), path.join(copy, "src"), { recursive: true });
    fs.writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: "fulmine.js", main: "src/index.js" }));

    fs.writeFileSync(
        path.join(root, "server.js"),
        `const express = require("fulmine.js");
const app = express();
app.get("/health", (req, res) => res.send("ok"));
const server = app.listen(0);
// the stub returns the app without binding, so this is the regression guard: without it a
// failure leaves a listening socket behind and hangs the run rather than failing it
if (server.listening) {
    console.log("REALLY LISTENED");
    server.close();
}
`
    );

    const { code, out } = run([path.join(root, "server.js")]);
    assert.doesNotMatch(out, /REALLY LISTENED/, "the application's own listen must not have bound a port");
    assert.strictEqual(code, 0);
    assert.match(out, /GET\s+\/health\s+µWS/);
});
