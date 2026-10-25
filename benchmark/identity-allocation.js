"use strict";

// Retained heap from identity compression hooks, isolated from sockets, response bodies and the
// rest of the framework. Run next to --null: timing noise and heap retention answer different questions.
const path = require("node:path");
const assert = require("node:assert/strict");
const { addWorktree, removeWorktree } = require("./harness.js");

if (typeof global.gc !== "function") {
    console.error(
        "Explicit GC is required. Run: node --expose-gc benchmark/identity-allocation.js [--against HEAD | --null]"
    );
    process.exit(1);
}

const args = process.argv.slice(2);
let control = false;
let against = "HEAD";
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--null") {
        control = true;
    } else if (args[i] === "--against" && args[i + 1] && !args[i + 1].startsWith("--")) {
        against = args[++i];
    } else {
        console.error(`Unknown or incomplete option: ${args[i]}`);
        process.exit(1);
    }
}

const count = 50000;
const rounds = 15;
const keep = [];
function end() {}
function writeHead() {}
function next() {}

function median(values) {
    return values.slice().sort((a, b) => a - b)[values.length >> 1];
}

function collect() {
    global.gc();
    global.gc();
}

function measure(middleware) {
    keep.length = 0;
    collect();
    const before = process.memoryUsage().heapUsed;
    const cpuBefore = process.cpuUsage();
    const start = process.hrtime.bigint();
    for (let i = 0; i < count; i++) {
        const req = { method: "GET", headers: {} };
        const res = { end, writeHead };
        middleware(req, res, next);
        keep.push(res);
    }
    const totalNs = Number(process.hrtime.bigint() - start);
    const cpu = process.cpuUsage(cpuBefore);
    collect();
    const heapBytes = process.memoryUsage().heapUsed - before;
    assert.equal(keep.length, count);
    return {
        nsPerOp: totalNs / count,
        cpuNsPerOp: ((cpu.user + cpu.system) * 1000) / count,
        bytesPerPendingResponse: heapBytes / count
    };
}

const all = { baseline: [], candidate: [] };
const totalStart = process.hrtime.bigint();
try {
    const entry = control ? null : addWorktree(against);
    const baseline = require(entry ? path.join(path.dirname(entry), "compression.js") : "../src/compression.js")();
    const candidate = require("../src/compression.js")();
    const arms = { baseline, candidate };
    for (let round = -2; round < rounds; round++) {
        for (const label of round % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
            const result = measure(arms[label]);
            if (round >= 0) {
                all[label].push(result);
            }
        }
    }
    const summary = {};
    for (const label of ["baseline", "candidate"]) {
        summary[label] = Object.fromEntries(
            Object.keys(all[label][0]).map((key) => [key, median(all[label].map((r) => r[key]))])
        );
    }
    console.log(
        JSON.stringify(
            {
                control,
                against: control ? null : against,
                node: process.version,
                platform: process.platform,
                count,
                rounds,
                warmupRounds: 2,
                workload: "GET without Accept-Encoding; retained pending response wrappers; no socket or response body",
                totalSeconds: Number(process.hrtime.bigint() - totalStart) / 1e9,
                summary,
                allocationSpeedup: summary.baseline.nsPerOp / summary.candidate.nsPerOp,
                heapReductionPercent:
                    100 * (1 - summary.candidate.bytesPerPendingResponse / summary.baseline.bytesPerPendingResponse),
                roundsData: all
            },
            null,
            2
        )
    );
} finally {
    keep.length = 0;
    if (!control) {
        removeWorktree();
    }
}
