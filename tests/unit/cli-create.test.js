// npx fulmine create <dir>, driven as a user drives it.
//
// What it writes is checked by running it: the JavaScript project is given this checkout as its
// fulmine.js and started, and the three routes are asked. The TypeScript one is type-checked with
// the compiler in this checkout's devDependencies, since a starter that does not compile is worse
// than none.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "../..");
const cli = path.join(ROOT, "src/cli.js");

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

/** @returns {string} a fresh directory, removed after the test */
function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-create-"));
    test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
    return dir;
}

/**
 * This checkout, as the project's `fulmine.js`, and the named devDependencies beside it. A
 * junction rather than a symlink, since on Windows only the former needs no privilege.
 *
 * @param {string} project
 * @param {string[]} [shared] packages to take from this checkout's node_modules
 */
function link(project, shared = []) {
    const modules = path.join(project, "node_modules");
    fs.mkdirSync(modules, { recursive: true });
    fs.symlinkSync(ROOT, path.join(modules, "fulmine.js"), "junction");
    for (const name of shared) {
        fs.mkdirSync(path.dirname(path.join(modules, name)), { recursive: true });
        fs.symlinkSync(path.join(ROOT, "node_modules", name), path.join(modules, name), "junction");
    }
}

/** @returns {Promise<number>} a port nothing is bound to right now */
function freePort() {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, () => {
            const { port } = /** @type {net.AddressInfo} */ (server.address());
            server.close(() => resolve(port));
        });
    });
}

test("create writes a JavaScript project that starts and answers", async () => {
    const parent = scratch();
    const { code, out } = run(["create", "demo"], parent);
    assert.strictEqual(code, 0, out);
    const project = path.join(parent, "demo");
    for (const file of ["package.json", "server.js", "public/index.html", "Dockerfile", ".gitignore"]) {
        assert.ok(fs.existsSync(path.join(project, file)), `${file} was not written`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));
    assert.strictEqual(pkg.name, "demo");
    assert.match(pkg.dependencies["fulmine.js"], /^\^\d+$/);
    // trixie, since bookworm's glibc and Alpine's musl both fail at require time
    assert.match(fs.readFileSync(path.join(project, "Dockerfile"), "utf8"), /FROM node:\d+-trixie-slim/);

    link(project);
    const port = await freePort();
    const child = spawn(process.execPath, ["server.js"], { cwd: project, env: { ...process.env, PORT: String(port) } });
    let log = "";
    child.stdout.on("data", (chunk) => (log += chunk));
    child.stderr.on("data", (chunk) => (log += chunk));
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`did not start:\n${log}`)), 10000);
            child.stdout.on("data", () => {
                if (log.includes("listening")) {
                    clearTimeout(timer);
                    resolve(undefined);
                }
            });
        });
        const base = `http://localhost:${port}`;
        assert.deepStrictEqual(await (await fetch(`${base}/api/hello`)).json(), { hello: "world" });
        assert.deepStrictEqual(await (await fetch(`${base}/api/items/7`)).json(), { id: "7" });
        const created = await fetch(`${base}/api/items`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "x" })
        });
        assert.strictEqual(created.status, 201);
        assert.deepStrictEqual(await created.json(), { name: "x" });
        const page = await fetch(`${base}/`);
        assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    } finally {
        // wait for it to be gone: on Windows a directory a process still sits in cannot be removed
        const gone = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await gone;
    }
});

test("create --ts writes a TypeScript project that compiles", () => {
    const parent = scratch();
    const { code, out } = run(["create", "demo-ts", "--ts"], parent);
    assert.strictEqual(code, 0, out);
    const project = path.join(parent, "demo-ts");
    assert.ok(fs.existsSync(path.join(project, "src/server.ts")));
    assert.ok(fs.existsSync(path.join(project, "tsconfig.json")));
    assert.ok(!fs.existsSync(path.join(project, "server.js")));

    link(project, ["typescript", "@types/node"]);
    const tsc = path.join(ROOT, "node_modules/typescript/bin/tsc");
    execFileSync(process.execPath, [tsc, "-p", project], { encoding: "utf8" });
    assert.ok(fs.existsSync(path.join(project, "dist/server.js")));
});

test("create refuses a directory with something in it, and asks for one when none is given", () => {
    const parent = scratch();
    fs.writeFileSync(path.join(parent, "notes.txt"), "mine");
    const taken = run(["create", parent]);
    assert.strictEqual(taken.code, 1);
    assert.match(taken.out, /is not empty/);
    assert.deepStrictEqual(fs.readdirSync(parent), ["notes.txt"]);

    const none = run(["create"]);
    assert.strictEqual(none.code, 1);
    assert.match(none.out, /Usage/);
});

test("create --pnpm makes the project own uWebSockets.js, which is what pnpm needs to install it", () => {
    const { UWS_SPEC } = require("../../src/adopt.js");
    const parent = scratch();
    const { code, out } = run(["create", "demo", "--pnpm"], parent);
    assert.strictEqual(code, 0, out);
    const project = path.join(parent, "demo");
    const pkg = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));
    assert.strictEqual(pkg.dependencies["uWebSockets.js"], UWS_SPEC);
    assert.strictEqual(
        fs.readFileSync(path.join(project, "pnpm-workspace.yaml"), "utf8"),
        'overrides:\n  "fulmine.js>uWebSockets.js": "-"\n'
    );
    assert.match(fs.readFileSync(path.join(project, "Dockerfile"), "utf8"), /pnpm install --frozen-lockfile --prod/);
    assert.match(out, /pnpm install/);

    // the same, read from how the command was started rather than from a flag
    const byAgent = scratch();
    execFileSync(process.execPath, [cli, "create", "agent"], {
        cwd: byAgent,
        encoding: "utf8",
        env: { ...process.env, npm_config_user_agent: "pnpm/11.13.0 npm/? node/v26.0.0 linux x64" }
    });
    assert.ok(fs.existsSync(path.join(byAgent, "agent", "pnpm-workspace.yaml")));

    // and an npm start does not carry any of it
    const plain = scratch();
    execFileSync(process.execPath, [cli, "create", "plain"], {
        cwd: plain,
        encoding: "utf8",
        env: { ...process.env, npm_config_user_agent: "npm/11.0.0 node/v26.0.0 linux x64" }
    });
    assert.ok(!fs.existsSync(path.join(plain, "plain", "pnpm-workspace.yaml")));
});
