"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("pending responses keep one native global handle", (t) => {
    assert.equal(process.version, "v26.11.1", "Budget requires Node 26.11.1");
    assert.equal(process.platform, "linux", "Budget requires Linux x64");
    assert.equal(process.arch, "x64", "Budget requires Linux x64");
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_V8_COVERAGE;
    const report = JSON.parse(
        execFileSync(process.execPath, [path.join(__dirname, "native-handles-probe.cjs")], {
            encoding: "utf8",
            timeout: 45000,
            env
        })
    );
    t.diagnostic(JSON.stringify(report));
    assert.equal(report.count, 128);
    assert.equal(report.pending.received, report.count);
    assert.equal(report.pending.aborted, 0);
    assert.equal(report.released.received, report.count);
    assert.equal(report.released.aborted, report.count, "every abort callback must run");
    const bytes = (report.pending.used - report.baseline.used) / report.count;
    assert.ok(bytes >= 0, "pending responses reduced the native handle count");
    assert.ok(bytes <= 40, `${bytes} > 40 B/pending response in native global handles`);
    assert.equal(report.released.used, report.baseline.used, "native global handles must be released");
});
