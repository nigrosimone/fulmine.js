// The socket stand-in, driven directly rather than through a request.
//
// req.socket and res.socket are one object and most of it forwards to the response, because µWS
// owns the connection and hands over nothing to forward to. What it answers is this project's own
// contract rather than express's, which is why it is pinned here and not in the comparison suite:
// there is no second server to agree with about what pause() does when there is no socket to pause.
// req-socket-shared.js is the other half, and that one does compare against express: identity, the
// members being there, and the tuning methods handing the socket back.

const test = require("node:test");
const assert = require("node:assert");

const express = require("../../src/index.js");

/**
 * A response with a µWS stand-in under it, and the calls it forwards recorded.
 * @returns {{res: any, calls: string[]}}
 */
function newResponse() {
    const calls = [];
    const app = express();
    const uwsRes = {
        onAborted: () => {},
        cork: (/** @type {Function} */ fn) => fn(),
        writeStatus: () => {},
        writeHeader: () => {},
        write: (/** @type {any} */ chunk) => {
            calls.push("write:" + String(chunk));
            return true;
        },
        end: (/** @type {any} */ body) => calls.push("end:" + String(body)),
        getWriteOffset: () => 0,
        onWritable: () => {},
        close: () => calls.push("close"),
        endWithoutBody: () => calls.push("endWithoutBody"),
        tryEnd: (/** @type {any} */ chunk) => {
            calls.push("tryEnd:" + String(chunk));
            return [true, true];
        },
        getRemotePort: () => 51789
    };
    const req = {
        _connectionClose: false,
        headers: {},
        method: "GET",
        parsedIp: "127.0.0.1",
        app,
        _res: uwsRes,
        pause: () => calls.push("req.pause"),
        resume: () => calls.push("req.resume")
    };
    const res = new app._response(uwsRes, req, app);
    req.res = res;
    return { res, calls };
}

test("the stand-in answers what a served socket answers about itself", () => {
    const { res } = newResponse();
    const socket = res.socket;
    assert.strictEqual(socket, res.socket, "built once and kept");
    assert.strictEqual(socket.readyState, "open");
    assert.strictEqual(socket.connecting, false);
    assert.strictEqual(socket.pending, false);
    assert.strictEqual(socket.destroyed, false);
    assert.strictEqual(socket.writable, true);
    assert.strictEqual(socket.readable, true);
    assert.strictEqual(socket.remoteAddress, "127.0.0.1");
    assert.strictEqual(socket.remotePort, 51789);
    assert.deepStrictEqual(socket.address(), { address: undefined, family: "IPv4", port: undefined });
});

test("the tuning methods do nothing and hand the socket back, as node's do", () => {
    const { res, calls } = newResponse();
    const socket = res.socket;
    assert.strictEqual(socket.setTimeout(0), socket);
    assert.strictEqual(socket.setKeepAlive(true, 1000), socket);
    assert.strictEqual(socket.setNoDelay(true), socket);
    assert.strictEqual(socket.ref(), socket);
    assert.strictEqual(socket.unref(), socket);
    assert.deepStrictEqual(calls, [], "none of them reaches µWS");
});

test("pause and resume hold the body arriving on the connection", () => {
    const { res, calls } = newResponse();
    const socket = res.socket;
    assert.strictEqual(socket.pause(), socket);
    assert.strictEqual(socket.resume(), socket);
    assert.deepStrictEqual(calls, ["req.pause", "req.resume"]);
});

test("writing to the socket goes through the response, since there is no way past the framing", () => {
    const { res, calls } = newResponse();
    assert.strictEqual(typeof res.socket.write("raw"), "boolean", "it answers what a write answers");
    // the response holds what it is given until it is finished, which is where µWS sees it
    res.end("tail");
    assert.ok(calls.join("|").includes("raw"), "the bytes reached µWS through the response: " + calls.join("|"));
});

test("destroy closes the connection and says so once", () => {
    const { res, calls } = newResponse();
    const socket = res.socket;
    let closed = 0;
    socket.on("close", () => closed++);
    assert.strictEqual(socket.destroy(), socket);
    assert.strictEqual(closed, 1);
    assert.strictEqual(socket.destroyed, true);
    assert.strictEqual(socket.readyState, "closed");
    assert.ok(calls.includes("close"), "µWS was told to drop it");

    // and a second destroy is not a second close: the response is already over
    socket.destroySoon();
    assert.strictEqual(closed, 1);
});
