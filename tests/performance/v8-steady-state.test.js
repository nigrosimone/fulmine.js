"use strict";

// After warmup the request path neither deoptimizes nor leaves TurboFan. A shape that changes
// late, or a hot function that stops optimizing, is a regression the throughput benchmarks see
// only as noise.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("the request path does not deoptimize in steady state, and its hot functions stay in TurboFan", (t) => {
    assert.equal(process.version, "v26.11.1", "Budget requires Node 26.11.1");
    assert.equal(process.platform, "linux", "Budget requires Linux x64");
    assert.equal(process.arch, "x64", "Budget requires Linux x64");
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_V8_COVERAGE;
    const output = execFileSync(process.execPath, [path.join(__dirname, "v8-steady-state-probe.cjs")], {
        encoding: "utf8",
        timeout: 120000,
        env
    });
    const report = JSON.parse(output.slice(output.indexOf('{"type"')));
    t.diagnostic(JSON.stringify(report));
    assert.ok(report.turbofanBit > 0, "the TurboFan bit could not be read off a probe function");
    assert.deepEqual(report.deopts, [], "a deopt in src after warmup");
    for (const [name, optimized] of Object.entries(report.optimized)) {
        assert.ok(optimized, `${name} is not TurboFan code after warmup`);
    }
});
