"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// 15 MB on Node 26.11.1, all of it from the warmup; the identity closures kept their request through
// the scavenges and made it 55
const budget = 32 * 1024 * 1024;

test("the young generation stays small under keep-alive load through compression", (t) => {
    assert.equal(process.version, "v26.11.1", "Budget requires Node 26.11.1");
    assert.equal(process.platform, "linux", "Budget requires Linux x64");
    assert.equal(process.arch, "x64", "Budget requires Linux x64");
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_V8_COVERAGE;
    const report = JSON.parse(
        execFileSync(process.execPath, [path.join(__dirname, "young-generation-probe.cjs")], {
            encoding: "utf8",
            timeout: 60000,
            env
        })
    );
    t.diagnostic(`largest new space ${(report.largest / 2 ** 20).toFixed(1)} MB`);
    assert.ok(report.largest <= budget, `new space ${report.largest} > ${budget} bytes`);
});
