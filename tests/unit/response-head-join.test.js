"use strict";

// writeHeaders joins a head into one µWS crossing from its third line on. The comparison suite
// sees the head only as a client parses it, and only what an application can set through the
// API, so this holds the join to the bytes one crossing per line wrote, over what nothing in the
// API can put in res.headers: a number, undefined, a Buffer, a list holding either, each between
// lines that join. µWS writes `name: value\r\n` for each crossing without reading either, and
// throws on a value that is neither text nor bytes, which the fake below does too.

const test = require("node:test");
const assert = require("node:assert");
const express = require("../../src/index.js");
const { HEADER_NAME_BUF, HEADER_VALUE_BUF } = require("../../src/response-utils.js");

/**
 * What µWS turns a crossing's argument into, as its NativeString does.
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

/** A µWS response that records every crossing. */
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
 * The head the way it went out before the join: one crossing per line, in the object's order.
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

test("a closing connection drops keep-alive, whoever set it, and nothing else", () => {
    compare({ connection: "close", "keep-alive": "timeout=10", "x-a": "1", "x-b": "2" });
    compare({ connection: "CLOSE", "keep-alive": "timeout=5", "x-a": "1" });
});

test("the pair is only the seeded pair", () => {
    compare({ connection: "keep-alive", "keep-alive": "timeout=5", "x-a": "1" });
    compare({ connection: "Keep-Alive", "keep-alive": "timeout=10", "x-a": "1" });
    compare({ "keep-alive": "timeout=10", connection: "keep-alive", "x-a": "1" });
    compare({ connection: "keep-alive", "x-a": "1", "keep-alive": "timeout=10" });
});

test("the framing is still µWS's", () => {
    compare({ ...PAIR, "content-length": "5", "x-a": "1", "x-b": "2" });
    compare({ ...PAIR, "transfer-encoding": "chunked", "x-a": "1", "x-b": "2" });
    compare({ ...PAIR, "transfer-encoding": "gzip", "x-a": "1", "x-b": "2" });
});

test("what nothing in the API stores crosses on its own, the lines around it in their order", () => {
    // false is what res.set stores for an unknown type, written as it stands
    compare({ ...PAIR, "x-a": "1", "content-type": false, "x-b": "2" });
    compare({ ...PAIR, "x-a": "1", "x-undefined": undefined, "x-b": "2", "x-c": "3" });
    compare({ ...PAIR, "x-a": "1", "x-bytes": Buffer.from("raw"), "x-b": "2" });
    compare({ ...PAIR, "x-a": "1", "x-list": ["2", Buffer.from("3")], "x-b": "4" });
    compare({ ...PAIR, "x-a": "1", "x-list": ["2", false], "x-b": "4" });
    // and one µWS throws on, after the lines in front of it went out
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
