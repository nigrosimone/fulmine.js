// npx fulmine override and npx fulmine angular, driven as a user drives them.
//
// Both edit a config file in somebody's project, so what matters as much as the line they add is
// what they refuse to touch: a substitution already pointing somewhere else, a file that is not
// valid JSON, an angular.json with no server build in it. Each of those has a case here.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const cli = path.join(__dirname, "../../src/cli.js");
const { version } = require("../../package.json");
const MAJOR = version.split(".")[0];
const WANTED = `npm:fulmine.js@^${MAJOR}`;

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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-adopt-"));
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content);
    }
    test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

/** @param {string} dir @param {string} name @returns {any} */
function readJson(dir, name) {
    return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
}

test("override writes npm's overrides when a package-lock is what is there", () => {
    const dir = fixture({
        "package.json": JSON.stringify({ name: "demo" }, null, 2) + "\n",
        "package-lock.json": "{}"
    });
    const { code, out } = run(["override", dir]);
    assert.strictEqual(code, 0);
    assert.match(out, /npm, because package-lock\.json is here/);
    assert.deepStrictEqual(readJson(dir, "package.json").overrides, { express: WANTED });
});

test("override writes pnpm.overrides for pnpm and resolutions for yarn", () => {
    const pnpm = fixture({ "package.json": "{}\n", "pnpm-lock.yaml": "" });
    assert.strictEqual(run(["override", pnpm]).code, 0);
    assert.deepStrictEqual(readJson(pnpm, "package.json").pnpm.overrides, { express: WANTED });

    const yarn = fixture({ "package.json": "{}\n", "yarn.lock": "" });
    assert.strictEqual(run(["override", yarn]).code, 0);
    assert.deepStrictEqual(readJson(yarn, "package.json").resolutions, { express: WANTED });
});

test("override believes the packageManager field over any lockfile lying around", () => {
    const dir = fixture({
        "package.json": JSON.stringify({ packageManager: "pnpm@9.0.0" }) + "\n",
        "package-lock.json": "{}"
    });
    const { out } = run(["override", dir]);
    assert.match(out, /pnpm, because the packageManager field says pnpm/);
    assert.deepStrictEqual(readJson(dir, "package.json").pnpm.overrides, { express: WANTED });
});

test("override keeps the indentation the file already used", () => {
    const dir = fixture({ "package.json": '{\n\t"name": "demo"\n}\n' });
    run(["override", dir]);
    assert.match(fs.readFileSync(path.join(dir, "package.json"), "utf8"), /\n\t"resolutions|\n\t"overrides/);
});

test("override changes nothing on --dry-run", () => {
    const before = JSON.stringify({ name: "demo" }) + "\n";
    const dir = fixture({ "package.json": before });
    const { code, out } = run(["override", dir, "--dry-run"]);
    assert.strictEqual(code, 0);
    assert.match(out, /would add to package\.json/);
    assert.strictEqual(fs.readFileSync(path.join(dir, "package.json"), "utf8"), before);
});

test("override says there is nothing to do when it is already there", () => {
    const dir = fixture({ "package.json": JSON.stringify({ overrides: { express: WANTED } }) + "\n" });
    const { code, out } = run(["override", dir]);
    assert.strictEqual(code, 0);
    assert.match(out, /already says npm:fulmine\.js/);
});

test("override refuses to overwrite somebody else's substitution", () => {
    const dir = fixture({ "package.json": JSON.stringify({ overrides: { express: "^5.1.0" } }) + "\n" });
    const { code, out } = run(["override", dir]);
    assert.strictEqual(code, 1);
    assert.match(out, /which is not this package/);
    assert.deepStrictEqual(readJson(dir, "package.json").overrides, { express: "^5.1.0" });
});

test("override refuses bun, which cannot load the binary at all", () => {
    const dir = fixture({ "package.json": "{}\n", "bun.lock": "" });
    const { code, out } = run(["override", dir]);
    assert.strictEqual(code, 1);
    assert.match(out, /bun does not load it/);
});

test("override says which file it could not read rather than throwing a parser error", () => {
    const dir = fixture({ "package.json": "{ not json" });
    const { code, out } = run(["override", dir]);
    assert.strictEqual(code, 1);
    assert.match(out, /is not valid JSON and was left alone/);
});

test("override reports a directory with no package.json in it", () => {
    const dir = fixture({});
    const { code, out } = run(["override", dir]);
    assert.strictEqual(code, 1);
    assert.match(out, /no package\.json in/);
});

const SSR_CONFIG = {
    projects: {
        demo: {
            architect: {
                build: { options: { browser: "src/main.ts", ssr: { entry: "src/server.ts" } } }
            }
        },
        widget: { architect: { build: { options: { browser: "src/main.ts" } } } }
    }
};

test("angular declares both names external in the server build and leaves the browser one alone", () => {
    const dir = fixture({ "angular.json": JSON.stringify(SSR_CONFIG, null, 2) + "\n" });
    const { code, out } = run(["angular", dir]);
    assert.strictEqual(code, 0);
    assert.match(out, /demo: declared fulmine\.js and uWebSockets\.js external/);
    const config = readJson(dir, "angular.json");
    assert.deepStrictEqual(config.projects.demo.architect.build.options.externalDependencies, [
        "fulmine.js",
        "uWebSockets.js"
    ]);
    assert.strictEqual(config.projects.widget.architect.build.options.externalDependencies, undefined);
});

test("angular keeps what was already declared external", () => {
    const config = JSON.parse(JSON.stringify(SSR_CONFIG));
    config.projects.demo.architect.build.options.externalDependencies = ["sharp"];
    const dir = fixture({ "angular.json": JSON.stringify(config, null, 2) + "\n" });
    run(["angular", dir]);
    assert.deepStrictEqual(readJson(dir, "angular.json").projects.demo.architect.build.options.externalDependencies, [
        "sharp",
        "fulmine.js",
        "uWebSockets.js"
    ]);
});

test("angular is idempotent", () => {
    const dir = fixture({ "angular.json": JSON.stringify(SSR_CONFIG, null, 2) + "\n" });
    run(["angular", dir]);
    const { code, out } = run(["angular", dir]);
    assert.strictEqual(code, 0);
    assert.match(out, /already external, nothing to change/);
});

test("angular reads the newer targets key as well as architect", () => {
    const dir = fixture({
        "angular.json":
            JSON.stringify({ projects: { demo: { targets: { build: { options: { outputMode: "server" } } } } } }) + "\n"
    });
    assert.strictEqual(run(["angular", dir]).code, 0);
    assert.deepStrictEqual(readJson(dir, "angular.json").projects.demo.targets.build.options.externalDependencies, [
        "fulmine.js",
        "uWebSockets.js"
    ]);
});

test("angular changes nothing on --dry-run", () => {
    const before = JSON.stringify(SSR_CONFIG, null, 2) + "\n";
    const dir = fixture({ "angular.json": before });
    const { code, out } = run(["angular", dir, "--dry-run"]);
    assert.strictEqual(code, 0);
    assert.match(out, /would declare/);
    assert.strictEqual(fs.readFileSync(path.join(dir, "angular.json"), "utf8"), before);
});

test("angular says so when every build target is a browser bundle", () => {
    const dir = fixture({
        "angular.json": JSON.stringify({ projects: { a: { architect: { build: { options: {} } } } } }) + "\n"
    });
    const { code, out } = run(["angular", dir]);
    assert.strictEqual(code, 1);
    assert.match(out, /no server build in angular\.json/);
});

test("angular takes the file itself as well as the directory holding it", () => {
    const dir = fixture({ "angular.json": JSON.stringify(SSR_CONFIG, null, 2) + "\n" });
    const { code, out } = run(["angular", path.join(dir, "angular.json")]);
    assert.strictEqual(code, 0);
    assert.match(out, /demo: declared/);
    assert.deepStrictEqual(readJson(dir, "angular.json").projects.demo.architect.build.options.externalDependencies, [
        "fulmine.js",
        "uWebSockets.js"
    ]);
});

test("angular reports a directory with no angular.json in it", () => {
    const dir = fixture({});
    const { code, out } = run(["angular", dir]);
    assert.strictEqual(code, 1);
    assert.match(out, /no angular\.json at/);
});

test("angular reports a path that is not there at all", () => {
    const { code, out } = run(["angular", path.join(fixture({}), "nowhere")]);
    assert.strictEqual(code, 1);
    assert.match(out, /no angular\.json at/);
});

test("the usage text names both commands", () => {
    const { out } = run([]);
    assert.match(out, /npx fulmine\.js override \[dir\]/);
    assert.match(out, /npx fulmine\.js angular \[dir\]/);
});
