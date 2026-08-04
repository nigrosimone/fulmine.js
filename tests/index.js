// npm run test - runs all tests
// npm run test routing - runs all tests in the routing category
// npm run test tests/tests/routing - runs all tests in the routing category
// npm run test tests/tests/listen/listen-random.js - runs the test at tests/tests/listen/listen-random.js

const fs = require("fs");
const path = require("path");
const test = require("node:test");
const childProcess = require("node:child_process");
const exec = require("util").promisify(childProcess.exec);
const assert = require("node:assert");

const TEST_TIMEOUT = 60000;

// see tests/win-exit-delay.cjs: without it every test crashes on exit under Node 24+ on Windows
const NODE_ARGS = process.platform === "win32" ? `--require "${path.join(__dirname, "win-exit-delay.cjs")}" ` : "";
// what a file asking for it gets, see tests/inspect-preload.cjs
const INSPECT_ARG = `--require "${path.join(__dirname, "inspect-preload.cjs")}" `;

const testPath = path.join(__dirname, "tests");

let testCategories = fs.readdirSync(testPath).sort((a, b) => parseInt(a) - parseInt(b));
const filterPath = process.argv[2];

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

            const secondLine = (testCode.split("\n")[1] || "").trim();
            let marker = null;
            const markerMatch = secondLine.match(/^\/\/\s*(OFF|INSPECT)(?::\s*(.*))?$/);
            if (markerMatch) {
                marker = markerMatch[1];
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
                    const execTest = async (module) => {
                        const command = `node ${NODE_ARGS}${marker === "INSPECT" ? INSPECT_ARG : ""}"${testPath}"`;
                        const options = { maxBuffer: 1024 * 1024 * 100, timeout: TEST_TIMEOUT, killSignal: "SIGKILL" };
                        for (let attempt = 1; ; attempt++) {
                            try {
                                return (await exec(command, options)).stdout;
                            } catch (error) {
                                // maxBuffer also kills the child, and retrying an output that big
                                // would only mislabel it as a hang
                                const timedOut = error.killed && !String(error.message).includes("maxBuffer");
                                if (!timedOut) {
                                    throw error;
                                }
                                if (attempt > 1) {
                                    throw new Error(
                                        `${module} timed out twice at ${TEST_TIMEOUT}ms running ${testPath}`,
                                        {
                                            cause: error
                                        }
                                    );
                                }
                                console.error(
                                    `${module} timed out after ${TEST_TIMEOUT}ms running ${testPath}, retrying once`
                                );
                            }
                        }
                    };

                    try {
                        // Express 5 is the reference. The package named "express" is v5, so the
                        // test file runs as written.
                        const expressOutput = await execTest("express");

                        // Run the same file against fulmine
                        const newCode = testCode.replace(
                            `const express = require("express");`,
                            `const express = require("../../../src/index.js");`
                        );
                        if (newCode === testCode) {
                            throw new Error("Test code does not contain require express");
                        }
                        fs.writeFileSync(testPath, newCode);
                        const fulmineOutput = await execTest("fulmine");

                        assert.strictEqual(fulmineOutput, expressOutput);
                    } finally {
                        fs.writeFileSync(testPath, testCode);
                        resolve();
                    }
                });
            });
        }
    });
}
