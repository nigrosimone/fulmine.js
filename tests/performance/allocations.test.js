"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const budgets = {
    identity: { allocated: 464, retained: 424 },
    "native-body": { allocated: 736, retained: 352 },
    "skipped-body": { allocated: 16 }
};

for (const [kind, budget] of Object.entries(budgets)) {
    test(`${kind} allocation budget`, (t) => {
        assert.equal(process.version, "v26.11.1", "Budgets require Node 26.11.1");
        assert.equal(process.platform, "linux", "Budgets require Linux x64");
        assert.equal(process.arch, "x64", "Budgets require Linux x64");
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        delete env.NODE_V8_COVERAGE;
        const report = JSON.parse(
            execFileSync(
                process.execPath,
                [
                    "--expose-gc",
                    "--jitless",
                    "--min-semi-space-size=16",
                    "--max-semi-space-size=16",
                    path.join(__dirname, "allocation-probe.cjs"),
                    kind
                ],
                { encoding: "utf8", timeout: 60000, env }
            )
        );
        t.diagnostic(`${kind}: ${JSON.stringify(report.summary)} B/request`);
        for (const [metric, limit] of Object.entries(budget)) {
            const values = report.summary.map((arm) => arm[metric]);
            assert.ok(Math.abs(values[0] - values[1]) <= 8, `${kind}/${metric}: unstable control ${values}`);
            for (const value of values)
                assert.ok(value <= limit, `${kind}/${metric}: ${value.toFixed(1)} > ${limit} B/request`);
        }
    });
}
