// What listen() decides for the benchmark routes, built as benchmark/server.js does: native or not,
// headers and query skipped or not. A lost decision answers the same, 30 to 50% slower.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const express = require("../../src/index.js");
const { routeReport } = require("../../src/testing.js");
const { otherRuntime } = require("../../src/uws.js");

const dir = path.join(__dirname, "..", "..", "benchmark", "scenarios");

// routes, answered by µWS, skipping the headers, skipping the query
const DECIDED = {
    "api-endpoint": [1, 1, 1, 0],
    "api-mixed": [5, 5, 4, 2],
    "arena-baseline-get": [1, 1, 1, 0],
    "arena-baseline-post": [1, 1, 0, 0],
    "body-json-4kb": [1, 1, 0, 0],
    "body-json-512kb": [1, 1, 0, 0],
    "body-json-echo": [1, 1, 0, 0],
    "fallback-scan": [500, 500, 500, 500],
    "hello-world": [1, 1, 1, 1],
    "high-concurrency": [1, 1, 1, 1],
    "json-list-gzip": [1, 1, 0, 0],
    "json-list": [1, 1, 1, 0],
    "middlewares-100": [1, 1, 0, 0],
    "nested-routers-3": [1, 1, 1, 1],
    "post-urlencoded": [1, 1, 0, 0],
    "query-string": [1, 1, 1, 0],
    "realistic-stack": [1, 1, 0, 0],
    "router-mounted-params": [1000, 1000, 1000, 1000],
    "routes-1000-params": [1000, 1000, 1000, 1000],
    "routes-1000": [1000, 1000, 1000, 1000]
};

// on Bun and Deno nothing is compiled for µWS
test("the benchmark scenarios keep what listen() decided for their routes", { skip: otherRuntime }, async () => {
    /** @type {Record<string, number[]>} */
    const decided = {};
    for (const file of fs.readdirSync(dir).sort()) {
        // the ones that take server.js's context, which writes files
        if (/\b(ctx|context)\./.test(fs.readFileSync(path.join(dir, file), "utf8"))) {
            continue;
        }
        const scenario = require(path.join(dir, file));
        const app = express();
        app.set("etag", false);
        app.set("x-powered-by", false);
        app.set("env", "production");
        app.set("declarative responses", false);
        await scenario.setup(app, express, {});
        const rows = routeReport(app);
        decided[file.replace(/\.js$/, "")] = [
            rows.length,
            rows.filter((row) => row.native).length,
            rows.filter((row) => row.skipHeaders).length,
            rows.filter((row) => row.skipQuery).length
        ];
    }
    assert.deepStrictEqual(decided, DECIDED);
});
