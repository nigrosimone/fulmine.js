"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// B/request on the server, the whole request: µWS wrappers, fulmine, the route. Medians on Node
// 26.11.1 plus a margin; a value that falls lowers its budget in the same commit
const budgets = {
    "GET /hello": 2336,
    "GET /json": 2536,
    "GET /users/:id?q": 2944,
    "GET /ua": 2552,
    "GET /mw/x": 2712,
    "GET /r/x": 2648,
    "GET /missing": 3432,
    "POST /echo json": 3624,
    "arena GET /baseline11": 1648,
    "arena POST /baseline11": 2720,
    "arena GET /json/:count br": 14352,
    "arena POST /echo": 2672
};
// a closure or a header object kept per request is more than this
const retainedBudget = 16;

const median = (values) => values.slice().sort((a, b) => a - b)[values.length >> 1];

for (const [label, budget] of Object.entries(budgets)) {
    test(`${label} request allocation budget`, (t) => {
        assert.equal(process.version, "v26.11.1", "Budgets require Node 26.11.1");
        assert.equal(process.platform, "linux", "Budgets require Linux x64");
        assert.equal(process.arch, "x64", "Budgets require Linux x64");
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        delete env.NODE_V8_COVERAGE;
        const report = JSON.parse(
            execFileSync(
                process.execPath,
                [path.join(__dirname, "request-allocation-probe.cjs"), ...label.split(" ")],
                {
                    encoding: "utf8",
                    timeout: 60000,
                    env
                }
            )
        );
        const allocated = median(report.samples.map((sample) => sample.allocated));
        const retained = median(report.samples.map((sample) => sample.retained));
        t.diagnostic(`${label}: allocated ${allocated.toFixed(1)}, retained ${retained.toFixed(1)} B/request`);
        for (const sample of report.samples)
            assert.equal(sample.gc, 0, "GC during allocation sample; result is invalid");
        assert.ok(allocated <= budget, `${label}: allocated ${allocated.toFixed(1)} > ${budget} B/request`);
        assert.ok(
            retained <= retainedBudget,
            `${label}: retained ${retained.toFixed(1)} > ${retainedBudget} B/request`
        );
    });
}
