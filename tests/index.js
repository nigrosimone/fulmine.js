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
            const markerMatch = secondLine.match(/^\/\/\s*(OFF)(?::\s*(.*))?$/);
            if (markerMatch) {
                marker = markerMatch[1];
            }

            await new Promise((resolve) => {
                test(testDescription, async (t) => {
                    if (marker === "OFF") {
                        t.skip();
                        return resolve();
                    }

                    let timeout;
                    const timeoutFunc = (module) => {
                        // Written straight to the file descriptor, before anything else.
                        //
                        // Throwing alone loses the message: the exit below happens on the next
                        // turn, which is sooner than the reporter gets round to printing why the
                        // test failed. A CI run on 2026-08-02 died here and the log said only that
                        // 60 seconds had passed, which leaves the one thing worth knowing out of
                        // it: whether the arm that hung was Express or this project. console.error
                        // is not enough either, since on a pipe it can be asynchronous and the
                        // process is already leaving.
                        fs.writeSync(2, `\n${module} timed out after ${TEST_TIMEOUT}ms running ${testPath}\n`);
                        setTimeout(() => process.exit(1));
                        throw `${module} timed out`;
                    };

                    const execTest = async (testPath) => {
                        return (await exec(`node ${NODE_ARGS}"${testPath}"`, { maxBuffer: 1024 * 1024 * 100 })).stdout;
                    };

                    try {
                        // Express 5 is the reference. The package named "express" is v5, so the
                        // test file runs as written.
                        timeout = setTimeout(() => timeoutFunc("express"), TEST_TIMEOUT);
                        const expressOutput = await execTest(testPath);
                        clearTimeout(timeout);

                        // Run the same file against fulmine
                        const newCode = testCode.replace(
                            `const express = require("express");`,
                            `const express = require("../../../src/index.js");`
                        );
                        if (newCode === testCode) {
                            throw new Error("Test code does not contain require express");
                        }
                        fs.writeFileSync(testPath, newCode);
                        timeout = setTimeout(() => timeoutFunc("fulmine"), TEST_TIMEOUT);
                        const fulmineOutput = await execTest(testPath);
                        clearTimeout(timeout);

                        assert.strictEqual(fulmineOutput, expressOutput);
                    } finally {
                        clearTimeout(timeout);
                        fs.writeFileSync(testPath, testCode);
                        resolve();
                    }
                });
            });
        }
    });
}
