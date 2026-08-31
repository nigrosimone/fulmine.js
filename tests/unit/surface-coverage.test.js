// types-surface.test.js asks whether everything this project adds is declared. This asks the
// opposite question, which is the one that costs an application a 500: what does Express carry that
// is not here at all. `req.socket.setTimeout` was missing for months, n8n's chat trigger calls it on
// every webhook it serves, and the TypeError came back as "Workflow could not be started!" with the
// cause swallowed by their error handler. Nothing in this repo could have said the method was gone.
//
// Both arms serve one request and are asked what the request, the response and the socket carry:
// Express through node's own server, this project through µWS. What Express has and this does not
// is a gap, and every gap has to be written down below with the reason it is one. A gap that closes
// fails here too, so the list cannot rot: it says what is missing today, not what was missing when
// somebody last looked.

const test = require("node:test");
const assert = require("node:assert");

const fulmine = require("../../src/index.js");
const express = require("express");

/**
 * Every property name reachable on an object, its prototype chain included. Node's own private
 * members are left out: an application that reaches for one has left the public surface.
 *
 * @param {any} object
 * @returns {Set<string>}
 */
function members(object) {
    const names = new Set();
    for (let o = object; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) {
        for (const name of Object.getOwnPropertyNames(o)) {
            if (!name.startsWith("_")) names.add(name);
        }
    }
    return names;
}

/**
 * Serves one request and reports what the three objects carried while it ran.
 *
 * @param {any} framework
 * @returns {Promise<{request: Set<string>, response: Set<string>, socket: Set<string>}>}
 */
async function surfaceOf(framework) {
    const app = framework();
    /** @type {any} */
    let seen;
    app.post("/surface", (req, res) => {
        seen = { request: members(req), response: members(res), socket: members(req.socket) };
        res.end("ok");
    });
    const server = await new Promise((done) => {
        const started = app.listen(0, () => done(started));
    });
    const port = (server.address ? server.address() : app.address()).port;
    await fetch(`http://127.0.0.1:${port}/surface`, {
        method: "POST",
        body: "x",
        headers: { "content-type": "text/plain" }
    });
    await new Promise((done) => server.close(() => done()));
    return seen;
}

// What Express has here and this project does not. Everything in this object is a known hole, not
// an approved one: closing any of them is welcome, and doing so fails this test until the name is
// taken out.
const GAPS = {
    request: new Set([
        // node's, and reachable: an application does read them. req.aborted is deprecated in node
        // but still read by middleware, and `upgrade` is what on-finished looks at first
        "aborted",
        "upgrade",
        // an IncomingMessage carries these for a client response and leaves them null on a server
        // request, so what is missing is two nulls
        "statusCode",
        "statusMessage",
        // the pre-node-0.12 name for socket, deprecated for a decade
        "client",
        // trailers arrive after the body and µWS does not hand them over
        "rawTrailers",
        // a flag of node's parser, set from a server option this project does not take
        "joinDuplicateHeaders"
    ]),
    response: new Set([
        // how node frames what it writes. µWS frames the response itself, so there is nothing here
        // to read or to set
        "chunkedEncoding",
        "shouldKeepAlive",
        "useChunkedEncodingByDefault",
        "strictContentLength",
        "outputData",
        "outputSize",
        "maxRequestsOnConnectionReached",
        // node adds the Date header unless this is turned off. It is added here always
        "sendDate",
        // 1xx informational responses, which µWS cannot send
        "writeInformation"
    ]),
    socket: new Set([
        // req.socket and res.socket are one stand-in, an EventEmitter with the address, the ports,
        // the tuning methods and the few things an application really calls: destroy, pause,
        // resume, write, end, address, ref. What is left below is the stream underneath, which µWS
        // owns and does not hand over: the buffers and their counters, the reading half, the
        // iteration helpers node's streams grew, and the handles to the parser and the server.
        // Nothing here can be answered with anything better than a lie.
        "allowHalfOpen",
        "bufferSize",
        "bytesRead",
        "bytesWritten",
        "closed",
        "compose",
        "connect",
        "cork",
        "drop",
        "errored",
        "every",
        "filter",
        "find",
        "flatMap",
        "forEach",
        "getTypeOfService",
        "isPaused",
        "iterator",
        "localAddress",
        "localFamily",
        "map",
        "parser",
        "pipe",
        "push",
        "read",
        "readableAborted",
        "readableBuffer",
        "readableDidRead",
        "readableEncoding",
        "readableEnded",
        "readableFlowing",
        "readableHighWaterMark",
        "readableLength",
        "readableObjectMode",
        "reduce",
        "remoteFamily",
        "resetAndDestroy",
        "server",
        "setDefaultEncoding",
        "setEncoding",
        "setTypeOfService",
        "some",
        "take",
        "toArray",
        "uncork",
        "unpipe",
        "unshift",
        "wrap",
        "writableBuffer",
        "writableCorked",
        "writableEnded",
        "writableFinished",
        "writableHighWaterMark",
        "writableLength",
        "writableNeedDrain",
        "writableObjectMode"
    ])
};

test("nothing Express carries goes missing here without being written down", async () => {
    const reference = await surfaceOf(express);
    const ours = await surfaceOf(fulmine);

    /** @type {Record<string, string[]>} */
    const unlisted = {};
    /** @type {Record<string, string[]>} */
    const closed = {};
    for (const kind of ["request", "response", "socket"]) {
        const missing = [...reference[kind]].filter((name) => !ours[kind].has(name));
        unlisted[kind] = missing.filter((name) => !GAPS[kind].has(name)).sort();
        // and the other way, so the list says what is missing now rather than what once was
        closed[kind] = [...GAPS[kind]].filter((name) => !missing.includes(name)).sort();
    }

    assert.deepStrictEqual(unlisted, { request: [], response: [], socket: [] });
    assert.deepStrictEqual(closed, { request: [], response: [], socket: [] });
});
