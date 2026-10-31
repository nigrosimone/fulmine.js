"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performance, PerformanceObserver } = require("node:perf_hooks");
const source = path.resolve(process.env.FULMINE_PERF_SOURCE || path.join(__dirname, "../../src"));
const count = 5000;
const rounds = 5;
const kind = process.argv[2];
assert.ok(["identity", "native-body", "skipped-body"].includes(kind));
assert.equal(typeof global.gc, "function");
const middleware =
    kind === "identity"
        ? require(path.join(source, "compression.js"))
        : // body-parser.js was middlewares.js until 2026-10-31, an older source is still read
          require(
              path.join(
                  source,
                  fs.existsSync(path.join(source, "body-parser.js")) ? "body-parser.js" : "middlewares.js"
              )
          ).text;

function fixture() {
    const keep = new Array(count).fill(null);
    let stored = 0;
    let continued = 0;
    function next() {
        continued++;
    }
    function end() {}
    function writeHead() {}
    const app = { get: () => undefined };
    const transport = {
        collectBody(limit, callback) {
            if (limit !== 102400) throw new Error("Unexpected body limit");
            keep[stored++] = callback;
        }
    };
    function rawHeader(name) {
        return name === "content-length" ? "2" : undefined;
    }
    function request() {
        return {
            method: "POST",
            bodyRead: false,
            receivedData: false,
            complete: false,
            readable: true,
            app,
            _rawHeader: rawHeader,
            _res: transport
        };
    }
    const run = kind === "identity" ? middleware() : middleware({ type: () => true });
    const skipped = { bodyRead: true };
    const emptyResponse = {};
    const skippedRequests = kind === "skipped-body" ? new Array(count) : null;
    const skippedResponses = kind === "skipped-body" ? new Array(count) : null;
    return {
        reset() {
            keep.fill(null);
            stored = 0;
            continued = 0;
            if (skippedRequests) {
                for (let i = 0; i < count; i++) {
                    skippedRequests[i] = { bodyRead: true };
                    skippedResponses[i] = {};
                }
            }
        },
        canary() {
            if (kind === "identity") {
                const headers = new Map([["content-type", "text/plain"]]);
                let ended = 0;
                const res = {
                    headersSent: false,
                    writeHead,
                    getHeader: (name) => headers.get(name.toLowerCase()),
                    setHeader: (name, value) => headers.set(name.toLowerCase(), value),
                    end() {
                        ended++;
                    }
                };
                run({ method: "GET", headers: {} }, res, next);
                res.end();
                assert.equal(ended, 1);
                assert.equal(headers.get("vary"), "Accept-Encoding");
                assert.equal(continued, 1);
            } else if (kind === "native-body") {
                const req = request();
                run(req, {}, next);
                assert.equal(stored, 1);
                assert.equal(continued, 0);
                keep[0](Buffer.from("20"));
                assert.equal(req.body, "20");
                assert.equal(continued, 1);
                assert.equal(req.complete, true);
                assert.equal(req.readable, false);
            } else {
                run(skipped, emptyResponse, next);
                assert.equal(continued, 1);
                assert.equal(Object.hasOwn(skipped, "body"), false);
            }
        },
        populate() {
            for (let i = 0; i < count; i++) {
                if (kind === "identity") {
                    const res = { end, writeHead };
                    run({ method: "GET", headers: {} }, res, next);
                    keep[i] = res;
                } else if (kind === "native-body") {
                    run(request(), {}, next);
                } else {
                    run(skippedRequests[i], skippedResponses[i], next);
                }
            }
        },
        verify() {
            assert.equal(continued, kind === "native-body" ? 0 : count);
            if (kind === "native-body") {
                assert.equal(stored, count);
                assert.notEqual(keep[0], keep[count - 1]);
                assert.equal(typeof keep[0], "function");
            } else if (kind === "identity") {
                for (const res of [keep[0], keep[count - 1]]) {
                    assert.notEqual(res.end, end);
                    assert.notEqual(res.writeHead, writeHead);
                    assert.equal(typeof res.flush, "function");
                }
            }
        }
    };
}

function median(values) {
    return values.slice().sort((a, b) => a - b)[values.length >> 1];
}
function collect() {
    global.gc();
    global.gc();
}
async function drain() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

async function main() {
    const arms = [fixture(), fixture()];
    for (const arm of arms) arm.canary();
    const samples = [[], []];
    let events = [];
    const observer = new PerformanceObserver((list) => {
        events.push(...list.getEntries());
    });
    observer.observe({ entryTypes: ["gc"] });
    try {
        for (let round = -2; round < rounds; round++) {
            for (const index of round % 2 === 0 ? [0, 1] : [1, 0]) {
                for (const arm of arms) arm.reset();
                collect();
                await drain();
                events = [];
                collect();
                const start = performance.now();
                const before = process.memoryUsage().heapUsed;
                arms[index].populate();
                const allocated = process.memoryUsage().heapUsed - before;
                const finish = performance.now();
                await drain();
                assert.equal(
                    events.filter((event) => event.startTime >= start && event.startTime < finish).length,
                    0,
                    "GC during allocation sample; result is invalid"
                );
                events = [];
                collect();
                const retained = process.memoryUsage().heapUsed - before;
                arms[index].verify();
                if (round >= 0) samples[index].push({ allocated: allocated / count, retained: retained / count });
            }
        }
        const summary = samples.map((arm) =>
            Object.fromEntries(
                ["allocated", "retained"].map((metric) => [metric, median(arm.map((sample) => sample[metric]))])
            )
        );
        console.log(JSON.stringify({ kind, node: process.version, source, count, rounds, summary, samples }));
    } finally {
        observer.disconnect();
        for (const arm of arms) arm.reset();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
