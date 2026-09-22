"use strict";

// writeHeaders joins the head in one uWS call from the third line on. The bytes must be the same
// as one call per line, also for values the API never stores (a number, undefined, a Buffer), that
// the comparison suite cannot reach.

const test = require("node:test");
const assert = require("node:assert");
const express = require("../../src/index.js");
const { HEADER_NAME_BUF, HEADER_VALUE_BUF } = require("../../src/response-utils.js");

/**
 * What uWS turns a value into, as its NativeString does.
 * @param {unknown} value
 * @returns {string}
 */
function asUws(value) {
    if (value === undefined) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (ArrayBuffer.isView(value)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("latin1");
    }
    if (value instanceof ArrayBuffer) {
        return Buffer.from(value).toString("latin1");
    }
    throw new TypeError("Text and data can only be passed by String, ArrayBuffer or TypedArray.");
}

/** A uWS response that records every writeHeader. */
function fakeUws() {
    const uws = {
        crossings: 0,
        wire: "",
        writeHeader(/** @type {unknown} */ name, /** @type {unknown} */ value) {
            const line = asUws(name) + ": " + asUws(value) + "\r\n";
            uws.crossings++;
            uws.wire += line;
            return uws;
        },
        onAborted() {},
        cork(/** @type {Function} */ fn) {
            fn();
        },
        writeStatus() {
            return uws;
        },
        write: () => true,
        end() {},
        endWithoutBody() {},
        getWriteOffset: () => 0,
        onWritable() {},
        close() {}
    };
    return uws;
}

/**
 * The head as it went out before the join, one call per line.
 * @param {Record<string, any>} headers
 * @param {ReturnType<typeof fakeUws>} uws
 */
function onePerLine(headers, uws) {
    const connection = headers["connection"];
    const closing = typeof connection === "string" && connection.length === 5 && connection.toLowerCase() === "close";
    for (const header in headers) {
        if (closing && header === "keep-alive") {
            continue;
        }
        const value = headers[header];
        if (header === "content-length") {
            continue;
        }
        if (header === "transfer-encoding" && typeof value === "string" && /(?:^|\W)chunked(?:$|\W)/i.test(value)) {
            continue;
        }
        const name = HEADER_NAME_BUF[header] || header;
        if (Array.isArray(value)) {
            for (const val of value) {
                uws.writeHeader(name, HEADER_VALUE_BUF[val] || val);
            }
        } else {
            uws.writeHeader(name, HEADER_VALUE_BUF[value] || value);
        }
    }
}

/**
 * Runs both over the same headers: the same bytes, and the same throw where one throws.
 * @param {Record<string, any>} headers
 * @returns {ReturnType<typeof fakeUws>} what the join wrote
 */
function compare(headers) {
    const app = express();
    const joinedUws = fakeUws();
    const res = new app._response(joinedUws, { _connectionClose: false, _isHead: false, headers: {} }, app);
    // the head as the application left it, seeded pair included unless the case replaces it
    res.headers = { ...headers };
    const reference = fakeUws();
    /** @type {unknown} */
    let referenceError;
    try {
        onePerLine({ ...headers }, reference);
    } catch (err) {
        referenceError = err;
    }
    /** @type {unknown} */
    let joinedError;
    try {
        res.writeHeaders(true);
    } catch (err) {
        joinedError = err;
    }
    assert.strictEqual(joinedUws.wire, reference.wire, "the same bytes, up to where either threw");
    assert.strictEqual(String(joinedError), String(referenceError), "and the same throw");
    return joinedUws;
}

const PAIR = { connection: "keep-alive", "keep-alive": "timeout=10" };

test("one or two lines keep a crossing each, the seeded pair counting as one", () => {
    assert.strictEqual(compare({ ...PAIR }).crossings, 1);
    assert.strictEqual(compare({ ...PAIR, "content-type": "text/html; charset=utf-8" }).crossings, 2);
    assert.strictEqual(compare({ "content-type": "text/plain" }).crossings, 1);
    assert.strictEqual(compare({ "x-a": "1", "x-b": "2" }).crossings, 2);
});

test("three lines or more cross once", () => {
    assert.strictEqual(compare({ ...PAIR, "x-a": "1", "x-b": "2" }).crossings, 1);
    assert.strictEqual(compare({ "x-a": "1", "x-b": "2", "x-c": "3" }).crossings, 1);
    const many = { ...PAIR };
    for (let i = 0; i < 16; i++) {
        many["x-line-" + i] = "value " + i;
    }
    assert.strictEqual(compare(many).crossings, 1);
});

test("a list is a line per entry, joined like any other", () => {
    assert.strictEqual(compare({ ...PAIR, "set-cookie": ["a=1", "b=2", "c=3"] }).crossings, 1);
    compare({ "set-cookie": ["a=1"] });
    compare({ "x-a": [], "x-b": "1" });
    compare({ ...PAIR, "x-a": "1", vary: ["accept", "origin"], "x-b": "2" });
});

test("a closing connection drops only keep-alive, whoever set it", () => {
    compare({ connection: "close", "keep-alive": "timeout=10", "x-a": "1", "x-b": "2" });
    compare({ connection: "CLOSE", "keep-alive": "timeout=5", "x-a": "1" });
});

test("the pair is only the seeded pair", () => {
    compare({ connection: "keep-alive", "keep-alive": "timeout=5", "x-a": "1" });
    compare({ connection: "Keep-Alive", "keep-alive": "timeout=10", "x-a": "1" });
    compare({ "keep-alive": "timeout=10", connection: "keep-alive", "x-a": "1" });
    compare({ connection: "keep-alive", "x-a": "1", "keep-alive": "timeout=10" });
});

test("the framing is still uWS's", () => {
    compare({ ...PAIR, "content-length": "5", "x-a": "1", "x-b": "2" });
    compare({ ...PAIR, "transfer-encoding": "chunked", "x-a": "1", "x-b": "2" });
    compare({ ...PAIR, "transfer-encoding": "gzip", "x-a": "1", "x-b": "2" });
});

test("a value the API never stores crosses alone, the lines around it keep their order", () => {
    // false, stored by res.set for an unknown type
    compare({ ...PAIR, "x-a": "1", "content-type": false, "x-b": "2" });
    compare({ ...PAIR, "x-a": "1", "x-undefined": undefined, "x-b": "2", "x-c": "3" });
    compare({ ...PAIR, "x-a": "1", "x-bytes": Buffer.from("raw"), "x-b": "2" });
    compare({ ...PAIR, "x-a": "1", "x-list": ["2", Buffer.from("3")], "x-b": "4" });
    compare({ ...PAIR, "x-a": "1", "x-list": ["2", false], "x-b": "4" });
    // one uWS throws on, after the lines before it went out
    compare({ ...PAIR, "x-a": "1", "x-b": "2", "x-number": 5, "x-c": "3" });
    compare({ "x-number": 5, "x-a": "1" });
    compare({ ...PAIR, "x-list": ["1", 2], "x-a": "3" });
});

test("behind the node shim every line crosses on its own", () => {
    const app = express();
    const uws = fakeUws();
    /** @type {any} */ (uws)._nodeRes = {};
    const res = new app._response(uws, { _connectionClose: false, _isHead: false, headers: {} }, app);
    res.headers = { "x-a": "1", "x-b": "2", "x-c": "3", "set-cookie": ["a=1", "b=2"] };
    res.writeHeaders(true);
    assert.strictEqual(uws.crossings, 5);
    assert.strictEqual(uws.wire, "x-a: 1\r\nx-b: 2\r\nx-c: 3\r\nset-cookie: a=1\r\nset-cookie: b=2\r\n");
});
