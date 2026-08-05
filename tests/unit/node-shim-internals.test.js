// The shim's exported internals, driven directly: the address byte round-trip on inputs a real
// socket can never produce, and the request/response wrappers over hand-built node objects.
// The socket-driven suite covers the live paths; this one covers the defensive ones.

const test = require("node:test");
const assert = require("node:assert");

const { NodeHttpRequest, NodeHttpResponse, addressToBytes } = require("../../src/node-shim.js");

test("addressToBytes answers bytes for real addresses and nothing for malformed ones", () => {
    // nothing in, nothing out
    assert.equal(addressToBytes(undefined).byteLength, 0);
    assert.equal(addressToBytes("").byteLength, 0);

    // the v4 forms, mapped and plain
    assert.deepEqual([...new Uint8Array(addressToBytes("1.2.3.4"))], [1, 2, 3, 4]);
    assert.deepEqual([...new Uint8Array(addressToBytes("::ffff:127.0.0.1"))], [127, 0, 0, 1]);

    // malformed v4: wrong part count, out-of-range octet, not a number
    assert.equal(addressToBytes("1.2.3").byteLength, 0);
    assert.equal(addressToBytes("1.2.3.999").byteLength, 0);
    assert.equal(addressToBytes("1.2.3.x").byteLength, 0);

    // v6: the "::" expands to however many zero groups are missing
    const loopback = new DataView(addressToBytes("::1"));
    assert.equal(loopback.byteLength, 16);
    assert.equal(loopback.getUint16(14), 1);
    const full = new DataView(addressToBytes("1:2:3:4:5:6:7:8"));
    assert.equal(full.getUint16(0), 1);
    assert.equal(full.getUint16(14), 8);
    const mixed = new DataView(addressToBytes("fe80::5:6"));
    assert.equal(mixed.getUint16(0), 0xfe80);
    assert.equal(mixed.getUint16(12), 5);
    assert.equal(mixed.getUint16(14), 6);

    // malformed v6: too few groups without a "::", and a group that is not hex
    assert.equal(addressToBytes("1:2:3").byteLength, 0);
    assert.equal(addressToBytes("zz::1").byteLength, 0);
});

test("the request wrapper answers uWS's questions from a hand-built message", () => {
    const req = new NodeHttpRequest(
        /** @type {any} */ ({
            method: "PATCH",
            url: "/x?a=1",
            rawHeaders: ["X-Multi", "a", "X-Multi", "b", "Single", "v"],
            headers: { "x-multi": ["a", "b"], single: "v" },
            socket: { remoteAddress: "127.0.0.1", remotePort: 1234 }
        })
    );

    assert.equal(req.getCaseSensitiveMethod(), "PATCH");
    assert.equal(req.getMethod(), "patch");
    // node pre-joins repeated headers; the wrapper joins whatever arrays remain
    assert.equal(req.getHeader("x-multi"), "a, b");
    assert.equal(req.getHeader("single"), "v");
    assert.equal(req.getHeader("absent"), "");
    // no native routes exist on this path, so a parameter is always the empty string
    assert.equal(req.getParameter(), "");
    const seen = [];
    req.forEach((key, value) => seen.push(key + "=" + value));
    assert.deepEqual(seen, ["x-multi=a", "x-multi=b", "single=v"]);
});

test("the response wrapper's edges: empty end, bare endWithoutBody, aborted tryEnd, close", () => {
    const calls = [];
    const fakeRes = /** @type {any} */ ({
        headersSent: false,
        setHeader: (k, v) => calls.push(["setHeader", k, v]),
        hasHeader: () => false,
        write: (buf) => {
            calls.push(["write", buf.length]);
            return true;
        },
        end: (body) => calls.push(["end", body === undefined ? undefined : String(body)]),
        destroy: () => calls.push(["destroy"]),
        on: () => {}
    });
    const fakeReq = /** @type {any} */ ({ socket: { remoteAddress: "::1", remotePort: 7 }, on: () => {} });

    const res = new NodeHttpResponse(fakeReq, fakeRes);

    // an ArrayBuffer chunk is uWS's native currency and must pass through the copy helper
    res.write(new ArrayBuffer(4));
    assert.deepEqual(calls.pop(), ["write", 4]);

    // an empty body ends without writing one
    res.end("");
    assert.deepEqual(calls.pop(), ["end", undefined]);

    // endWithoutBody with no length sets nothing and just ends
    res.endWithoutBody();
    assert.deepEqual(calls.pop(), ["end", undefined]);

    // an aborted response refuses further sized writes, reporting done
    res._aborted = true;
    assert.deepEqual(res.tryEnd(Buffer.from("x"), 1), [false, true]);
    res.end("late");
    assert.equal(
        calls.some((c) => c[0] === "end" && c[1] === "late"),
        false
    );
    res._aborted = false;

    // close drops the connection without finishing anything
    res.close();
    assert.deepEqual(calls.pop(), ["destroy"]);

    // and the address surface answers text and port
    assert.equal(res.getRemoteAddressAsText().toString(), "::1");
    assert.equal(res.getRemotePort(), 7);
    assert.equal(new DataView(res.getRemoteAddress()).getUint16(14), 1);
});
