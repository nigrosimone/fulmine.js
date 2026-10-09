// What fulmine asks µWS for, request by request, against a budget: a native call that starts
// happening where it was not needed fails here, even though the answer stays the same and only the
// speed goes. The ip (about 350ns a read) only where the route reads req.ip, the port only where
// something reached for the socket, onData and collectBody only for a body, onAborted only for a
// response that outlives its handler, the headers and the query only for a route that reads them,
// and the head written in as few calls as it takes. See native-census.app.js for the routes.
//
// A count that falls is good news, and the table is brought down to it in the same commit.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { otherRuntime } = require("../../src/uws.js");

// counts per request, what is not listed is never called
const BUDGET = {
    "GET /hello": { end: 1, getHeader: 5, writeHeader: 1 },
    "GET /json": { end: 1, getHeader: 5, writeHeader: 1 },
    "GET /users/42?q=x": {
        end: 1,
        getCaseSensitiveMethod: 1,
        getHeader: 5,
        getParameter: 1,
        getQuery: 1,
        getUrl: 1,
        writeHeader: 1
    },
    // the query is read though the route does not need it: a skip still to be earned, not a target
    "GET /ip": { end: 1, forEach: 1, getQuery: 1, getRemoteAddress: 1, writeHeader: 1 },
    "GET /ua": { end: 1, forEach: 1, getQuery: 1, writeHeader: 1 },
    "POST /echo": {
        collectBody: 1,
        cork: 1,
        end: 1,
        forEach: 1,
        getQuery: 1,
        onAborted: 1,
        onData: 1,
        writeHeader: 1
    },
    "GET /parsed": { end: 1, getHeader: 5, writeHeader: 1 },
    "GET /async": { cork: 1, end: 1, getHeader: 5, onAborted: 1, writeHeader: 1 },
    "GET /mw/x": { end: 1, getHeader: 5, writeHeader: 1 },
    "GET /socket": { end: 1, forEach: 1, getQuery: 1, getRemotePort: 1, writeHeader: 1 },
    "GET /missing": {
        cork: 1,
        end: 1,
        forEach: 1,
        getCaseSensitiveMethod: 1,
        getQuery: 1,
        getUrl: 1,
        onAborted: 1,
        writeHeader: 1,
        writeStatus: 1
    }
};

/** @returns {Record<string, Record<string, number>>} */
function census() {
    const run = spawnSync(process.execPath, [path.join(__dirname, "native-census.app.js")], {
        encoding: "utf8",
        timeout: 60000
    });
    assert.strictEqual(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
}

/**
 * The requests that call the method, in the order asked.
 *
 * @param {Record<string, Record<string, number>>} counts
 * @param {string} method
 * @returns {string[]}
 */
const callers = (counts, method) => Object.keys(counts).filter((request) => counts[request][method]);

// on Bun and Deno there is no µWS to count
test("µWS is asked for nothing a request does not need", { skip: otherRuntime }, () => {
    const counts = census();
    assert.deepStrictEqual(callers(counts, "getRemoteAddress"), ["GET /ip"], "the ip only where req.ip is read");
    assert.deepStrictEqual(
        callers(counts, "getRemotePort"),
        ["GET /socket"],
        "the port only where the socket is reached for"
    );
    assert.deepStrictEqual(callers(counts, "onData"), ["POST /echo"], "onData only for a body");
    assert.deepStrictEqual(callers(counts, "collectBody"), ["POST /echo"], "collectBody only for a body");
    assert.deepStrictEqual(
        callers(counts, "onAborted"),
        ["POST /echo", "GET /async", "GET /missing"],
        "onAborted only for a response that outlives its handler"
    );
    // the whole table: a call that grows, or appears, is named in the diff
    assert.deepStrictEqual(counts, BUDGET);
});
