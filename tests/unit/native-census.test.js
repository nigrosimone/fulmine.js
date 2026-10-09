// What fulmine asks µWS for per request, against a budget: a call not needed fails here, even if
// the answer is the same. Routes in native-census.app.js. A count that falls: lower the table.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { otherRuntime } = require("../../src/uws.js");

// counts per request, a method not listed is never called. Margins not taken yet: res.cookie and
// res.write copy the headers, /chunks corks twice, a 204 writes its head in two calls. getQuery
// beside a full header copy costs 15 to 45ns against the copy's 760, not worth a rule
const BUDGET = {
    "GET /hello": { end: 1, getHeader: 5, writeHeader: 1 },
    "HEAD /hello": { endWithoutBody: 1, getHeader: 5, writeHeader: 1 },
    "OPTIONS /hello": {
        cork: 1,
        end: 1,
        forEach: 1,
        getCaseSensitiveMethod: 1,
        getQuery: 1,
        getUrl: 1,
        onAborted: 1,
        writeHeader: 1
    },
    "GET /hello, conditional": { endWithoutBody: 1, getHeader: 6, writeHeader: 2, writeStatus: 1 },
    "GET /hello, connection close": { end: 1, getHeader: 5, writeHeader: 1 },
    "GET /json": { end: 1, getHeader: 5, writeHeader: 1 },
    "GET /created": { end: 1, getHeader: 5, writeHeader: 1, writeStatus: 1 },
    "GET /headers": { end: 1, forEach: 1, getQuery: 1, writeHeader: 1 },
    "GET /chunks": { cork: 2, endWithoutBody: 1, forEach: 1, getQuery: 1, write: 2, writeHeader: 1 },
    "GET /redirect": { end: 1, forEach: 1, getQuery: 1, writeHeader: 1, writeStatus: 1 },
    "GET /status": { endWithoutBody: 1, getHeader: 5, writeHeader: 2, writeStatus: 1 },
    "GET /users/42?q=x": {
        end: 1,
        getCaseSensitiveMethod: 1,
        getHeader: 5,
        getParameter: 1,
        getQuery: 1,
        getUrl: 1,
        writeHeader: 1
    },
    "GET /users/%41": {
        end: 1,
        getCaseSensitiveMethod: 1,
        getHeader: 5,
        getParameter: 1,
        getQuery: 1,
        getUrl: 1,
        writeHeader: 1
    },
    "GET /ip": { end: 1, forEach: 1, getQuery: 1, getRemoteAddress: 1, writeHeader: 1 },
    "GET /ip, trust proxy": { end: 1, forEach: 1, getQuery: 1, getRemoteAddress: 1, writeHeader: 1 },
    "GET /ua": { end: 1, forEach: 1, getQuery: 1, writeHeader: 1 },
    "GET /socket": { end: 1, forEach: 1, getQuery: 1, getRemotePort: 1, writeHeader: 1 },
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
    "POST /form": {
        collectBody: 1,
        cork: 1,
        end: 1,
        forEach: 1,
        getQuery: 1,
        onAborted: 1,
        onData: 1,
        writeHeader: 1
    },
    "POST /text": {
        collectBody: 1,
        cork: 1,
        end: 1,
        forEach: 1,
        getQuery: 1,
        onAborted: 1,
        onData: 1,
        writeHeader: 1
    },
    "POST /small, over the limit": {
        cork: 1,
        end: 1,
        forEach: 1,
        getQuery: 1,
        onAborted: 1,
        onData: 1,
        writeHeader: 1,
        writeStatus: 1
    },
    "GET /parsed": { end: 1, getHeader: 5, writeHeader: 1 },
    "GET /parsed, declaring a body": { end: 1, forEach: 1, getHeader: 2, onData: 1, writeHeader: 1 },
    "GET /file": { cork: 1, end: 1, forEach: 1, getQuery: 1, onAborted: 1, writeHeader: 1 },
    "GET /static/small.txt": {
        cork: 1,
        end: 1,
        forEach: 1,
        getCaseSensitiveMethod: 1,
        getQuery: 1,
        getUrl: 1,
        onAborted: 1,
        writeHeader: 1
    },
    "GET /async": { cork: 1, end: 1, getHeader: 5, onAborted: 1, writeHeader: 1 },
    "GET /mw/x": { end: 1, getHeader: 5, writeHeader: 1 },
    "GET /r/x": { end: 1, getHeader: 5, writeHeader: 1 },
    "GET /hello, with an error handler": { end: 1, getHeader: 5, writeHeader: 1 },
    "GET /throw": { end: 1, getHeader: 5, writeHeader: 1, writeStatus: 1 },
    "GET /reject": { cork: 1, end: 1, getHeader: 5, onAborted: 1, writeHeader: 1, writeStatus: 1 },
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
        timeout: 120000
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
    assert.deepStrictEqual(
        callers(counts, "getRemoteAddress"),
        ["GET /ip", "GET /ip, trust proxy"],
        "the ip only where req.ip is read"
    );
    assert.deepStrictEqual(
        callers(counts, "getRemotePort"),
        ["GET /socket"],
        "the port only where the socket is reached for, not for trust proxy's own read of the peer"
    );
    assert.deepStrictEqual(
        callers(counts, "onData"),
        ["POST /echo", "POST /form", "POST /text", "POST /small, over the limit", "GET /parsed, declaring a body"],
        "onData only for a request that declares a body"
    );
    assert.deepStrictEqual(
        callers(counts, "collectBody"),
        ["POST /echo", "POST /form", "POST /text"],
        "collectBody only for a body within the limit"
    );
    // the whole table: a call that grows, or appears, is named in the diff
    assert.deepStrictEqual(counts, BUDGET);
});
