// npm run test - runs all tests
// npm run test routing - runs all tests in the routing category
// npm run test tests/tests/routing - runs all tests in the routing category
// npm run test tests/tests/listen/listen-random.js - runs the test at tests/tests/listen/listen-random.js

const fs = require("fs");
const path = require("path");
const net = require("node:net");
const test = require("node:test");
const childProcess = require("node:child_process");
const exec = require("util").promisify(childProcess.exec);
const assert = require("node:assert");

const TEST_TIMEOUT = 60000;

// The test files share a handful of ports, and two uWS servers can hold one at the same time:
// verified on Windows, where the second listen succeeds and the older server keeps answering. A
// file that starts while the previous one is still exiting would then read the previous file's
// answers, and the express and fulmine arms of one file could both be served by whichever bound
// first, which is worse than a red test: it is a green one that compared a server with itself.
const PORT_IN_SOURCE = /listen\(\s*(\d{4,5})/g;
const PORT_WAIT_STEPS = 200;
const PORT_WAIT_MS = 25;

/** @param {string} code @returns {number[]} the ports this file listens on */
function portsOf(code) {
    return [...new Set([...code.matchAll(PORT_IN_SOURCE)].map((match) => Number(match[1])))];
}

/** @param {number} port @returns {Promise<boolean>} whether anything answers there right now */
function portBusy(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        const done = (busy) => {
            socket.destroy();
            resolve(busy);
        };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        socket.setTimeout(500, () => done(false));
    });
}

/** Waits until nothing is listening on these ports, so a run cannot reach the run before it. */
async function waitForFreePorts(ports) {
    for (const port of ports) {
        for (let step = 0; step < PORT_WAIT_STEPS; step++) {
            if (!(await portBusy(port))) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, PORT_WAIT_MS));
        }
    }
}

// see tests/win-exit-delay.cjs: without it every test crashes on exit under Node 24+ on Windows
const NODE_ARGS = process.platform === "win32" ? `--require "${path.join(__dirname, "win-exit-delay.cjs")}" ` : "";
// what a file asking for it gets, see tests/inspect-preload.cjs
const INSPECT_ARG = `--require "${path.join(__dirname, "inspect-preload.cjs")}" `;
// the reference arm of a --self run, see tests/generic-preload.cjs
const GENERIC_ARG = `--require "${path.join(__dirname, "generic-preload.cjs")}" `;

// --self replaces the Express arm with a second run of this framework, with the optimizer off.
// Every file then answers the question the corpus was not written for: does µWS answering by itself
// give what the ordinary chain gives. A divergence is a bug by construction rather than a
// compatibility question, so nothing about Express bounds what it can catch.
const SELF = process.argv.includes("--self");

const testPath = path.join(__dirname, "tests");

let testCategories = fs.readdirSync(testPath).sort((a, b) => parseInt(a) - parseInt(b));
const filterPath = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;

if (filterPath) {
    if (!filterPath.endsWith(".js")) {
        testCategories = testCategories.filter((category) => category.startsWith(path.basename(filterPath)));
    } else {
        // basename, not split(path.sep): on Windows path.sep is a backslash, so a path typed with
        // forward slashes never split and the whole "tests/tests/middlewares" came back as the
        // category name. path.basename handles either separator on both platforms
        testCategories = [path.basename(path.dirname(filterPath))];
    }
}

// how many files this run will go through, so every line can say where it is
const plannedTotal = testCategories.reduce((count, category) => {
    const names = fs.readdirSync(path.join(testPath, category)).filter((name) => name.endsWith(".js"));
    if (filterPath && filterPath.endsWith(".js")) {
        return count + names.filter((name) => path.basename(name) === path.basename(filterPath)).length;
    }
    return count + names.length;
}, 0);
let planned = 0;

// The file that is on disk with its import swapped for the local source right now, and what it
// says as written. The run puts it back in a finally, which covers a failing test but not a
// Ctrl+C: without this, an interrupted run leaves one test comparing fulmine against fulmine.
/** @type {{path: string, code: string}|null} */
let swapped = null;

function restoreSwapped() {
    if (swapped) {
        fs.writeFileSync(swapped.path, swapped.code);
        swapped = null;
    }
}

process.on("exit", restoreSwapped);
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
        restoreSwapped();
        process.exit(1);
    });
}

for (const testCategory of testCategories) {
    test(testCategory, async () => {
        // some tests write scratch directories next to themselves, and a leftover one
        // would otherwise be read as if it were a test file
        const tests = fs
            .readdirSync(path.join(__dirname, "tests", testCategory))
            .filter((testName) => testName.endsWith(".js"))
            .sort((a, b) => parseInt(a) - parseInt(b));
        for (const testName of tests) {
            if (filterPath && filterPath.endsWith(".js")) {
                if (path.basename(testName) !== path.basename(filterPath)) {
                    continue;
                }
            }
            const testPath = path.join(__dirname, "tests", testCategory, testName);
            const testCode = fs
                .readFileSync(testPath, "utf8")
                .replace(`const express = require("../../../src/index.js");`, 'const express = require("express");');
            if (!testCode.includes(`const express = require("express")`)) {
                throw new Error("Test code does not contain require express");
            }
            fs.writeFileSync(testPath, testCode);
            const testDescription = testCode.split("\n")[0].slice(2).trim();

            // The marker lives in the comment block at the top, and not always on the second line:
            // a file whose description runs to a paragraph writes it under that instead, and seven
            // of them did while this only ever read line two, so those seven were never inspected.
            // Only the leading block is read, so the word further down in a test cannot switch a
            // file's inspection on by accident.
            let marker = null;
            for (const line of testCode.split("\n").slice(1)) {
                const trimmed = line.trim();
                if (trimmed !== "" && !trimmed.startsWith("//")) {
                    break;
                }
                const markerMatch = trimmed.match(/^\/\/\s*(OFF|INSPECT)(?::\s*(.*))?$/);
                if (markerMatch) {
                    marker = markerMatch[1];
                    break;
                }
            }

            await new Promise((resolve) => {
                test(`${testDescription} (${++planned}/${plannedTotal})`, async (t) => {
                    if (marker === "OFF") {
                        t.skip();
                        return resolve();
                    }

                    // exec kills the child at the limit, so a hung arm rejects here instead of
                    // hanging the run. One retry, because a shared CI runner can stall for a
                    // minute for reasons that are nobody's code (res-send-file-large, node 24,
                    // 2026-08-04); the second timeout is a real hang and fails with the arm's name.
                    const ports = portsOf(testCode);
                    const execTest = async (module) => {
                        await waitForFreePorts(ports);
                        const generic = module === "generic" ? GENERIC_ARG : "";
                        const command = `node ${NODE_ARGS}${marker === "INSPECT" ? INSPECT_ARG : ""}${generic}"${testPath}"`;
                        const options = { maxBuffer: 1024 * 1024 * 100, timeout: TEST_TIMEOUT, killSignal: "SIGKILL" };
                        for (let attempt = 1; ; attempt++) {
                            try {
                                return (await exec(command, options)).stdout;
                            } catch (error) {
                                // maxBuffer also kills the child, and retrying an output that big
                                // would only mislabel it as a hang
                                const timedOut = error.killed && !String(error.message).includes("maxBuffer");
                                // The libuv exit assertion this project already carries a preload
                                // for, see tests/win-exit-delay.cjs. The child prints everything it
                                // was going to print and then dies on the way out, so the run is
                                // sound and only the exit code is not. It is timing dependent, so
                                // one retry clears it; twice in a row is something else and fails.
                                const crashedOnExit = String(error.stderr || "").includes("UV_HANDLE_CLOSING");
                                if (!timedOut && !crashedOnExit) {
                                    throw error;
                                }
                                const what = timedOut ? `timed out at ${TEST_TIMEOUT}ms` : "crashed on exit in libuv";
                                if (attempt > 1) {
                                    throw new Error(`${module} ${what} twice running ${testPath}`, {
                                        cause: error
                                    });
                                }
                                console.error(`${module} ${what} running ${testPath}, retrying once`);
                            }
                        }
                    };

                    try {
                        const newCode = testCode.replace(
                            `const express = require("express");`,
                            `const express = require("../../../src/index.js");`
                        );
                        if (newCode === testCode) {
                            throw new Error("Test code does not contain require express");
                        }

                        // Express 5 is the reference. The package named "express" is v5, so the
                        // test file runs as written. Under --self the reference is this framework
                        // with its optimizer off, so the file points at the source for both arms
                        // and only the preload differs.
                        let expressOutput;
                        if (SELF) {
                            swapped = { path: testPath, code: testCode };
                            fs.writeFileSync(testPath, newCode);
                            expressOutput = await execTest("generic");
                        } else {
                            expressOutput = await execTest("express");
                            swapped = { path: testPath, code: testCode };
                            fs.writeFileSync(testPath, newCode);
                        }
                        const fulmineOutput = await execTest("fulmine");

                        if (fulmineOutput !== expressOutput) {
                            // kept on disk, because the assertion prints a truncated diff and a
                            // disagreement that does not happen again is only diagnosable from
                            // what the two arms actually wrote
                            const dir = path.join(__dirname, "..", "test-failures");
                            fs.mkdirSync(dir, { recursive: true });
                            const stem = path.join(dir, `${testCategory}-${testName.replace(/\.js$/, "")}`);
                            fs.writeFileSync(`${stem}.express.txt`, expressOutput);
                            fs.writeFileSync(`${stem}.fulmine.txt`, fulmineOutput);
                            console.error(`wrote ${stem}.express.txt and ${stem}.fulmine.txt`);
                        }
                        assert.strictEqual(fulmineOutput, expressOutput);
                    } finally {
                        fs.writeFileSync(testPath, testCode);
                        swapped = null;
                        resolve();
                    }
                });
            });
        }
    });
}
