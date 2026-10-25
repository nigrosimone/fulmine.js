// The identity hooks keep the captured request/response for the filter and the call receiver for
// the original methods. These probes exercise method wrapping without a socket or native engine.
const test = require("node:test");
const assert = require("node:assert/strict");
const compression = require("../../src/compression.js");

function response() {
    const headers = new Map();
    return {
        headersSent: false,
        getHeader(name) {
            return headers.get(name.toLowerCase());
        },
        setHeader(name, value) {
            headers.set(name.toLowerCase(), value);
        },
        end(...args) {
            return { receiver: this, args };
        },
        writeHead(...args) {
            return { receiver: this, args };
        }
    };
}

test("identity hooks retain their original request and response when a method is borrowed", () => {
    for (const method of ["end", "writeHead"]) {
        const req = { method: "GET", headers: {} };
        const original = response();
        const receiver = response();
        let calls = 0;
        compression({
            filter(seenReq, seenRes) {
                calls++;
                assert.equal(seenReq, req);
                assert.equal(seenRes, original);
                return true;
            }
        })(req, original, () => {});

        const args = method === "end" ? ["body", "utf8"] : [201, "Created", { "Content-Type": "text/plain" }];
        const result = original[method].apply(receiver, args);
        assert.equal(result.receiver, receiver);
        assert.deepEqual(result.args, method === "end" ? ["body", "utf8", undefined] : [201, "Created"]);
        assert.equal(calls, 1);
        assert.equal(original.getHeader("Vary"), "Accept-Encoding");
        assert.equal(receiver.getHeader("Vary"), undefined);
        if (method === "writeHead") {
            assert.equal(receiver.getHeader("Content-Type"), "text/plain");
            assert.equal(original.getHeader("Content-Type"), undefined);
        }
    }
});

test("an identity filter can reenter end without rerunning itself or replacing the Cache-Control snapshot", () => {
    const req = { method: "GET", headers: { "accept-encoding": "identity" } };
    const res = response();
    res.setHeader("Cache-Control", "public");
    let calls = 0;
    compression({
        filter() {
            calls++;
            assert.equal(calls, 1);
            res.setHeader("Cache-Control", "no-transform");
            res.end("inside filter");
            return true;
        }
    })(req, res, () => {});
    res.end("outside filter");
    assert.equal(calls, 1);
    assert.equal(res.getHeader("Vary"), "Accept-Encoding");
});

test("a throwing identity filter is not called again by a later response method", () => {
    const req = { method: "GET", headers: {} };
    const res = response();
    const failure = new Error("filter failed");
    let calls = 0;
    compression({
        filter() {
            calls++;
            throw failure;
        }
    })(req, res, () => {});
    assert.throws(() => res.end("first"), failure);
    assert.doesNotThrow(() => res.writeHead(200, { "Content-Type": "text/plain" }));
    assert.equal(calls, 1);
    assert.equal(res.getHeader("Vary"), undefined);
});
