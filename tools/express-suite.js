"use strict";

// Express's own test suite, run against Fulmine.
//
//   node tools/express-suite.js                   every file
//   node tools/express-suite.js res.sendFile      only the files whose name contains this
//   node tools/express-suite.js --express         the same run against Express itself, as a control
//   node tools/express-suite.js --verbose         print mocha's output for the files that failed
//   node tools/express-suite.js --json out.json   the table as data
//
// It clones expressjs/express at the tag matching the installed `express` devDependency, swaps its
// index.js for one that requires src/index.js from here, and runs mocha one file at a time. The
// clone lives in node_modules/.cache/express-suite and is reused; pass --refresh to throw it away.
//
// This is a bug mine, not a gate. In one afternoon it found: body parser errors that carried no
// status, so every bad body was answered 500 instead of 400, 413 or 415; express.json() accepting
// "a string", 123, true and null, because `strict` never ran; a directory redirect that answered
// `Location: //assets/`, a protocol relative URL pointing off this server; and every res.sendFile
// error arriving as a bare Error, so a 403 was answered as a 500. None of those were reachable from
// the suite in tests/, because a test only finds what someone thought to write.
//
// It is not a gate, for three reasons that are not going away.
//
// The clone keeps Express's own lib/ in place and only index.js is swapped, so a test that imports
// from there is exercising Express's code rather than ours. test/utils.js is entirely that and
// passes whatever we do; four other files borrow lib/utils only for its list of HTTP methods. Rows
// that import from lib/ are marked `lib` so the number is read for what it is.
//
// Some of what it reports is Express's internals used as public API. `express.Route` is a class we
// do not have and `router.handle` is a method we do not have, so those files fail almost completely
// and say very little about whether an application would work.
//
// And a pass count would need a list of expected failures, which rots the moment either project
// moves. So this prints a table and exits 0 unless it could not set itself up.
//
// On Windows every one of these processes hangs at exit rather than in a test, which is a libuv bug
// in Node 24 and later and not ours: mocha has printed its results long before. So the run watches
// the output, and once the summary has arrived and the output has been quiet for a moment it kills
// the process instead of waiting for it. A row marked `exit` is that, and its counts are good.

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REPO = "https://github.com/expressjs/express.git";
const DEFAULT_DIR = path.join(ROOT, "node_modules", ".cache", "express-suite");
const SHIM_MARKER = "written by tools/express-suite.js";
// Express's own `npm test` adds --check-leaks and includes test/acceptance. Neither is wanted here:
// the acceptance files run Express's example applications, which is not compatibility, and a leak
// check would fail tests that had passed over globals belonging to uWS. Mocha's own default of two
// seconds per test is left alone: a test that fails by waiting for a callback that will never come
// costs that much whatever it is set to, and Router.js has enough of those to run for minutes.
const MOCHA_ARGS = ["--require", "test/support/env", "--reporter", "dot"];
// The backstop, for a file that hangs in a test rather than at exit. Generous because it is only
// ever paid by a file that has something wrong with it: a healthy one is killed as soon as its
// output goes quiet after the summary, and the whole suite runs in about two minutes that way.
const TIMEOUT_MS = 120000;
// how long the output has to stay quiet after the summary before the process is killed rather than
// waited for. Mocha prints the epilogue first and the failure details after it, so this cannot fire
// on the summary line itself without losing the part that says what went wrong
const GRACE_MS = 1500;

function parseArgs(argv) {
    const args = { filters: [] };
    for (let i = 0; i < argv.length; i++) {
        const value = argv[i];
        if (!value.startsWith("--")) {
            args.filters.push(value);
            continue;
        }
        const key = value.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

function run(command, commandArgs, cwd) {
    const result = spawnSync(
        // npm is a batch file on Windows, which will not spawn as "npm". Naming it outright rather
        // than passing shell: true, which node warns about and which would need the arguments
        // escaped by hand
        process.platform === "win32" && command === "npm" ? "npm.cmd" : command,
        commandArgs,
        {
            cwd,
            encoding: "utf8",
            stdio: "inherit"
        }
    );
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${commandArgs.join(" ")} exited with ${result.status}`);
    }
}

function readVersion(dir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
    } catch {
        return null;
    }
}

/**
 * The tag to test against: whichever Express the comparison suite in tests/ is running, so that the
 * two agree on what "Express says" means.
 */
function wantedTag(explicit) {
    if (explicit && explicit !== true) {
        const value = String(explicit);
        return value.startsWith("v") ? value : `v${value}`;
    }
    const installed = readVersion(path.join(ROOT, "node_modules", "express"));
    if (!installed) {
        throw new Error(
            "express is not installed here, so there is no version to match. Run npm install, or pass --tag v5.2.1"
        );
    }
    return `v${installed}`;
}

function ensureSuite(dir, tag, refresh) {
    const wanted = tag.slice(1);
    const isDefault = path.resolve(dir) === path.resolve(DEFAULT_DIR);
    if (fs.existsSync(dir)) {
        const current = readVersion(dir);
        if (refresh || current !== wanted) {
            if (!isDefault) {
                // a directory someone named on the command line is theirs, not ours to delete
                throw new Error(
                    `${dir} holds express ${current || "nothing recognisable"}, not ${wanted}. Point --dir elsewhere or update it yourself`
                );
            }
            console.log(`replacing the clone: it holds ${current || "nothing recognisable"} and this wants ${wanted}`);
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }
    if (!fs.existsSync(dir)) {
        console.log(`cloning express ${tag}`);
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        run("git", ["clone", "--quiet", "--depth", "1", "--branch", tag, REPO, dir], ROOT);
    }
    if (!fs.existsSync(path.join(dir, "node_modules", "mocha"))) {
        console.log("installing the suite's own dependencies, which takes a minute the first time");
        run("npm", ["install", "--no-audit", "--no-fund", "--loglevel", "error"], dir);
    }
    const mocha = path.join(dir, "node_modules", "mocha", "bin", "mocha.js");
    if (!fs.existsSync(mocha)) {
        throw new Error(`no mocha at ${mocha}`);
    }
    return mocha;
}

/**
 * Points the clone's entry at src/index.js, keeping Express's own next to it so the control run and
 * anything else that opens this directory later finds it as it was.
 */
function useFulmine(dir) {
    const entry = path.join(dir, "index.js");
    const backup = `${entry}.express-original`;
    const current = fs.readFileSync(entry, "utf8");
    if (!current.includes(SHIM_MARKER)) {
        fs.writeFileSync(backup, current);
    }
    const target = path.join(ROOT, "src", "index.js").split(path.sep).join("/");
    fs.writeFileSync(entry, `// ${SHIM_MARKER}\nmodule.exports = require(${JSON.stringify(target)});\n`);
}

function useExpress(dir) {
    const entry = path.join(dir, "index.js");
    const backup = `${entry}.express-original`;
    if (fs.existsSync(backup)) {
        fs.copyFileSync(backup, entry);
    }
}

function runFile(dir, mocha, file, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [mocha, ...MOCHA_ARGS, file], {
            cwd: dir,
            stdio: ["ignore", "pipe", "pipe"]
        });
        let out = "";
        let killed = false;
        let grace = null;
        const kill = () => {
            killed = true;
            child.kill("SIGKILL");
        };
        const hard = setTimeout(kill, timeoutMs);
        const onChunk = (chunk) => {
            out += chunk;
            if (!/\d+ (passing|failing|pending)/.test(out)) {
                return;
            }
            clearTimeout(grace);
            grace = setTimeout(kill, GRACE_MS);
        };
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", onChunk);
        child.stderr.on("data", onChunk);
        const done = () => {
            clearTimeout(hard);
            clearTimeout(grace);
            resolve({ out, killed });
        };
        child.on("close", done);
        child.on("error", (err) => {
            out += String(err);
            done();
        });
    });
}

function count(out, word) {
    const match = out.match(new RegExp(`(\\d+) ${word}`));
    return match ? Number(match[1]) : 0;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const dir = args.dir && args.dir !== true ? path.resolve(String(args.dir)) : DEFAULT_DIR;
    const timeoutMs = args.timeout && args.timeout !== true ? Number(args.timeout) : TIMEOUT_MS;
    const tag = wantedTag(args.tag);
    const mocha = ensureSuite(dir, tag, !!args.refresh);

    if (args.express) {
        useExpress(dir);
    } else {
        useFulmine(dir);
    }

    const testDir = path.join(dir, "test");
    const files = fs
        .readdirSync(testDir)
        .filter((name) => name.endsWith(".js"))
        .filter((name) => args.filters.length === 0 || args.filters.some((filter) => name.includes(filter)))
        .sort();

    if (files.length === 0) {
        throw new Error(`no test file matches ${args.filters.join(", ")}`);
    }

    console.log(`${args.express ? "express" : "fulmine"} against express ${tag}, ${files.length} files\n`);

    const rows = [];
    const started = Date.now();
    for (const name of files) {
        const source = fs.readFileSync(path.join(testDir, name), "utf8");
        // it borrows from Express's own lib/, which the clone still has, so whatever it reports is
        // partly or wholly about Express rather than about us
        const usesLib = /require\(['"]\.\.\/lib\//.test(source);
        const { out, killed } = await runFile(dir, mocha, `test/${name}`, timeoutMs);
        const passing = count(out, "passing");
        const failing = count(out, "failing");
        const finished = /\d+ (passing|failing|pending)/.test(out);
        const row = { name, passing, failing, finished, killed, usesLib, out };
        rows.push(row);
        const mark = !finished ? "hang" : failing > 0 ? "FAIL" : "ok";
        const notes = [usesLib ? "lib" : "", killed && finished ? "exit" : ""].filter(Boolean).join(" ");
        console.log(
            `${mark.padEnd(5)}${name.padEnd(26)}${finished ? `${String(passing).padStart(4)} passing${String(failing).padStart(5)} failing` : "  no result".padEnd(26)}  ${notes}`
        );
    }

    const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
    const failed = rows.filter((row) => row.failing > 0);
    const ours = rows.filter((row) => !row.usesLib);
    console.log("");
    console.log(
        `${rows.length} files in ${Math.round((Date.now() - started) / 1000)}s, ${rows.filter((row) => !row.finished).length} with no result`
    );
    console.log(`${sum("passing")} passing, ${sum("failing")} failing`);
    console.log(
        `without the files that import express's own lib/: ${ours.reduce((t, r) => t + r.passing, 0)} passing, ${ours.reduce((t, r) => t + r.failing, 0)} failing`
    );
    if (failed.length) {
        console.log(`\nfailing files: ${failed.map((row) => row.name).join(", ")}`);
    }

    if (args.verbose) {
        for (const row of failed) {
            console.log(`\n${"=".repeat(70)}\n${row.name}\n${"=".repeat(70)}\n${row.out}`);
        }
    }

    if (args.json) {
        const target = args.json === true ? path.join(ROOT, "express-suite.json") : path.resolve(String(args.json));
        const data = rows.map((row) => ({
            name: row.name,
            passing: row.passing,
            failing: row.failing,
            finished: row.finished,
            killed: row.killed,
            usesLib: row.usesLib
        }));
        fs.writeFileSync(target, JSON.stringify(data, null, 2));
        console.log(`\nwritten to ${target}`);
    }

    // Express's, so that the next thing to open this directory finds what it expects
    useExpress(dir);
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
