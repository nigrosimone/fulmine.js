"use strict";

// The first publish, from a machine logged in to npm. Later ones go through the Release workflow.
//
//   node tools/release-local.js 5.0.0-rc.1 --dry-run   rehearse, change nothing
//   node tools/release-local.js 5.0.0-rc.1             do it
//   node tools/release-local.js 5.0.0-rc.1 --skip-tests   after a publish that failed at the end
//
// Everything that can fail happens before anything becomes public, and the tag is pushed only once
// npm has accepted the package.

const { spawnSync } = require("child_process");
const readline = require("readline");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BRANCH = "main";

function parseArgs(argv) {
    const args = { flags: new Set(), version: null };
    for (const value of argv) {
        if (value.startsWith("--")) {
            args.flags.add(value.slice(2));
        } else if (!args.version) {
            args.version = value;
        }
    }
    return args;
}

// npm and npx are batch files on Windows, and node refuses to spawn one directly since the argument
// injection fix. Through the command interpreter, the way node's own shell option does it
function spawnable(command, args) {
    if (process.platform === "win32" && (command === "npm" || command === "npx")) {
        return [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command, ...args]];
    }
    return [command, args];
}

function run(command, args, options = {}) {
    const [file, argv] = spawnable(command, args);
    const result = spawnSync(file, argv, { cwd: ROOT, stdio: "inherit", ...options });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
    }
}

function capture(command, args) {
    const [file, argv] = spawnable(command, args);
    const result = spawnSync(file, argv, { cwd: ROOT, encoding: "utf8" });
    return { ok: result.status === 0, out: (result.stdout || "").trim(), err: (result.stderr || "").trim() };
}

function fail(message) {
    console.error(`\n${message}\n`);
    process.exit(1);
}

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (answer) => (rl.close(), resolve(answer.trim()))));
}

/** The remote pointing at this package's repository, whatever it was named locally. */
function findRemote() {
    const remotes = capture("git", ["remote", "-v"]).out.split("\n");
    for (const line of remotes) {
        const [name, url] = line.split(/\s+/);
        if (url && url.includes("fulmine.js")) {
            return name;
        }
    }
    fail("no git remote points at fulmine.js");
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const dryRun = args.flags.has("dry-run");
    const version = args.version;
    if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
        fail("usage: node tools/release-local.js <version> [--dry-run] [--skip-tests]");
    }

    const pkg = require(path.join(ROOT, "package.json"));
    const prerelease = version.split("-")[1];
    // a prerelease published without a tag still becomes latest
    const distTag = prerelease ? prerelease.split(".")[0] : "latest";
    const remote = findRemote();

    console.log(`\n${pkg.name} ${pkg.version} -> ${version}, publishing under the "${distTag}" tag`);
    console.log(`remote ${remote}, branch ${BRANCH}${dryRun ? ", dry run" : ""}\n`);

    // a modified tracked file means publishing something other than what CI tested. An untracked
    // one only matters when npm would pack it, which is anything under the files field
    const dirty = capture("git", ["status", "--porcelain"]).out.split("\n").filter(Boolean);
    const changed = dirty.filter((line) => !line.startsWith("??"));
    if (changed.length) {
        fail(`the working tree is not clean:\n${changed.join("\n")}`);
    }
    const packed = new Set(pkg.files);
    const untracked = dirty.map((line) => line.slice(3));
    const wouldShip = untracked.filter((file) => packed.has(file.replace(/\/$/, "").split("/")[0]));
    if (wouldShip.length) {
        fail(`untracked files npm would publish:\n${wouldShip.join("\n")}`);
    }
    if (untracked.length) {
        console.log(`untracked, and not published: ${untracked.join(", ")}`);
    }

    run("git", ["fetch", remote, "--quiet"]);
    const head = capture("git", ["rev-parse", "HEAD"]).out;
    const upstream = capture("git", ["rev-parse", `${remote}/${BRANCH}`]).out;
    if (head !== upstream) {
        fail(`HEAD is not ${remote}/${BRANCH}. Push or pull first`);
    }

    const whoami = capture("npm", ["whoami"]);
    if (!whoami.ok) {
        // a rehearsal is worth running without a login, since everything after this is what it is
        // meant to exercise
        if (!dryRun) {
            fail("not logged in to npm. Run npm login first");
        }
        console.log("not logged in to npm, which the real run would refuse");
    } else {
        console.log(`npm user: ${whoami.out}`);
    }

    if (capture("npm", ["view", `${pkg.name}@${version}`, "version"]).ok) {
        fail(`${pkg.name}@${version} is on npm already`);
    }

    if (!args.flags.has("skip-tests")) {
        console.log("\nthe gate: lint, format, types, unit tests, the comparison suite\n");
        run("npm", ["run", "lint"]);
        run("npm", ["run", "format:check"]);
        run("npm", ["run", "typecheck"]);
        run("npm", ["run", "test:unit"]);
        run("npm", ["test"]);
        run("npm", ["run", "test:types"]);
    }

    // release-it bumps, writes the CHANGELOG, commits and tags. It never publishes: npm.publish is
    // false in .release-it.cjs. Nothing is pushed here, so a failed publish leaves nothing behind
    console.log("\nbumping and tagging\n");
    const releaseItArgs = ["release-it", version, "--ci", "--no-git.push"];
    if (dryRun) {
        releaseItArgs.push("--dry-run");
    }
    run("npx", releaseItArgs);

    if (dryRun) {
        console.log("\ndry run: nothing was bumped, published or pushed");
        return;
    }

    const answer = await ask(`\npublish ${pkg.name}@${version} under "${distTag}"? [y/N] `);
    if (answer.toLowerCase() !== "y") {
        console.log("stopped. The bump and the tag are local: git reset --hard HEAD~1 && git tag -d v" + version);
        return;
    }

    run("npm", ["publish", "--tag", distTag]);
    run("git", ["push", remote, `HEAD:${BRANCH}`]);
    run("git", ["push", remote, `v${version}`]);

    console.log(`
published, and the tag is pushed.

What is left, by hand:
  - create the release on GitHub from the tag v${version}, paste the notes, tick "pre-release"
  - check the install: npm install ${pkg.name}@${distTag}
`);
}

main().catch((err) => {
    console.error(`\n${err.message || err}\n`);
    process.exit(1);
});
