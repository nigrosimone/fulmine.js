// What fulmine publishes on express's express.router.request TracingChannel, request by request,
// against what express printed for the same app (see tracing-router-request.app.js), on uWS and
// through http.createServer(app)

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const app = path.join(__dirname, "tracing-router-request.app.js");
const fulmine = path.join(__dirname, "..", "..", "src", "index.js");
const expected = fs
    .readFileSync(path.join(__dirname, "tracing-router-request.expected.txt"), "utf8")
    .replace(/\r/g, "");

/**
 * The output split by request, the request line first.
 *
 * @param {string} text
 * @returns {string[][]}
 */
const byRequest = (text) =>
    text
        .trim()
        .split(/\n(?=\S)/)
        .map((block) => block.split("\n"));

// A known difference, not of the tracing: express hands an error out of a mounted router at once
// when it runs out of layers while matching, fulmine a microtask later, so the same events come
// out in another order there, and the router's end has not seen the error yet
const ORDER_DIFFERS = new Set(["GET /mounted/param/%E0%A4%A 500"]);

/**
 * The events of a block in any order, a start or end without the error it carried.
 *
 * @param {string[]} block
 * @returns {string[]}
 */
const unordered = (block) =>
    block
        .map((line) => (/^ {2}(start|end) /.test(line) ? line.replace(/ error=.*?(?= route=| \w+$)/, "") : line))
        .sort();

for (const transport of ["uws", "node-http"]) {
    test(`the events are express's, ${transport}`, () => {
        const run = spawnSync(process.execPath, [app, fulmine, transport], { encoding: "utf8", timeout: 60000 });
        assert.strictEqual(run.status, 0, run.stderr);
        const actual = byRequest(run.stdout.replace(/\r/g, ""));
        const wanted = byRequest(expected);
        assert.deepStrictEqual(
            actual.map((block) => block[0]),
            wanted.map((block) => block[0])
        );
        for (let i = 0; i < wanted.length; i++) {
            if (ORDER_DIFFERS.has(wanted[i][0])) {
                assert.deepStrictEqual(unordered(actual[i]), unordered(wanted[i]), wanted[i][0]);
            } else {
                assert.deepStrictEqual(actual[i], wanted[i], wanted[i][0]);
            }
        }
    });
}

test("without a subscriber nothing is traced, the walk reads it once", () => {
    const script = `
        const { tracing } = require(${JSON.stringify(path.join(__dirname, "..", "..", "src", "tracing.js"))});
        const dc = require("node:diagnostics_channel");
        const before = tracing();
        const channel = dc.tracingChannel("express.router.request");
        const handler = { start() {} };
        channel.subscribe(handler);
        const during = tracing();
        channel.unsubscribe(handler);
        process.stdout.write([before, during, tracing()].join(" "));
    `;
    const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stdout, "false true false");
});

test("a route uWS would answer with a response written at listen() runs its handler when traced", () => {
    // alone on its route, so without a subscriber it is a declarative response running no javascript
    const script = `
        const dc = require("node:diagnostics_channel");
        const express = require(${JSON.stringify(fulmine)});
        const names = [];
        dc.tracingChannel("express.router.request").subscribe({ start: (ctx) => names.push(ctx.layer.name) });
        const app = express();
        // a response carrying a validator is never compiled
        app.set("etag", false);
        // an arrow, the form the compiler reads
        app.get("/text", (req, res) => res.send("text"));
        const server = app.listen(0, async () => {
            const res = await fetch("http://127.0.0.1:" + server.address().port + "/text");
            process.stdout.write((await res.text()) + " " + names.join(","));
            process.exit(0);
        });
    `;
    const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 60000 });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stdout, "text <anonymous>");
});
