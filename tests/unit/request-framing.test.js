// A request whose framing cannot be trusted is refused before any route runs.
//
// uWS accepts a repeated content-length and frames on the first, dropping the rest, where node's
// parser refuses the request outright. That difference is a request smuggling hook: a proxy in
// front that reads the last one instead forwards bytes that uWS then answers as a second, pipelined
// request, and the answer lands on whoever reuses that connection. These go over a raw socket
// because no http client will send two content-lengths.

const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");

const express = require("../../src/index.js");

/**
 * Starts an app that answers both paths, and hands back the port.
 *
 * @returns {Promise<{port: number, close: () => void, served: string[]}>}
 */
function serve() {
    return new Promise((resolve) => {
        const served = [];
        const app = express();
        app.use(express.json());
        const mark = (req, res) => {
            served.push(req.method + " " + req.path);
            res.json({ path: req.path, body: req.body ?? null });
        };
        app.all("/", mark);
        app.all("/smuggled", mark);
        app.listen(0, () => {
            resolve({ port: app.address().port, close: () => app.close(), served });
        });
    });
}

/**
 * Writes raw bytes and collects whatever comes back, until the server goes quiet or hangs up.
 *
 * @param {number} port
 * @param {string} payload
 * @returns {Promise<string>}
 */
function raw(port, payload) {
    return new Promise((resolve) => {
        const socket = net.connect(port, "127.0.0.1");
        let out = "";
        let settled = false;
        /** @type {NodeJS.Timeout|undefined} */
        let quiet;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(quiet);
            socket.destroy();
            resolve(out);
        };
        socket.setTimeout(3000);
        socket.on("connect", () => socket.write(payload));
        socket.on("data", (chunk) => {
            out += chunk.toString("latin1");
            clearTimeout(quiet);
            // the answer may be followed by a second one, so this waits for the stream to settle
            // rather than resolving on the first byte
            quiet = setTimeout(done, 150);
        });
        socket.on("timeout", done);
        socket.on("error", done);
        socket.on("close", done);
    });
}

/** How many HTTP answers came back on the connection. */
function answerCount(text) {
    return (text.match(/HTTP\/1\.1 /g) ?? []).length;
}

const BODY = '{"ok":true}'; // 11 bytes

test("two content-lengths are refused, whatever they say", async () => {
    const { port, close, served } = await serve();

    for (const pair of ["11\r\nContent-Length: 11", "11\r\nContent-Length: 40", "40\r\nContent-Length: 11"]) {
        const answer = await raw(
            port,
            `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
                `Content-Length: ${pair}\r\n\r\n${BODY}`
        );
        assert.strictEqual(answer, "", `a repeated content-length must not be answered: ${pair}`);
    }
    assert.deepStrictEqual(served, [], "no route may run for a request that was refused");

    close();
});

test("a repeated content-length cannot smuggle a second request", async () => {
    const { port, close, served } = await serve();

    // the first length frames just the json, the second would swallow what follows it: a proxy
    // reading either one forwards this whole thing, and uWS used to answer the tail as its own
    // request
    const smuggled = `GET /smuggled HTTP/1.1\r\nHost: x\r\n\r\n`;
    const answer = await raw(
        port,
        `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${BODY.length}\r\nContent-Length: ${BODY.length + smuggled.length}\r\n\r\n` +
            BODY +
            smuggled
    );

    assert.strictEqual(answer, "", "the connection must be closed without an answer");
    assert.ok(!served.includes("GET /smuggled"), "the smuggled request must never reach a route");
    assert.deepStrictEqual(served, [], "and neither must the request carrying it");

    close();
});

test("a repeated content-length of zero is refused too, on a request with no body", async () => {
    const { port, close, served } = await serve();

    // the cheap header path reads content-length through uWS's getHeader, which only ever returns
    // the first, so this shape used to walk straight past the check
    const smuggled = `GET /smuggled HTTP/1.1\r\nHost: x\r\n\r\n`;
    const answer = await raw(
        port,
        `GET / HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nContent-Length: ${smuggled.length}\r\n\r\n${smuggled}`
    );

    assert.strictEqual(answer, "", "the connection must be closed without an answer");
    assert.deepStrictEqual(served, [], "no route may run, for either request");

    close();
});

test("one content-length still works, and so does honest pipelining", async () => {
    const { port, close, served } = await serve();

    const single = await raw(
        port,
        `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${BODY.length}\r\n\r\n${BODY}`
    );
    assert.match(single, /^HTTP\/1\.1 200 /, "an ordinary request must still be answered");
    assert.match(single, /"ok":true/, "and its body must still be parsed");

    // two requests written at once, which is legal and must keep working: the refusal must not
    // have turned pipelining off
    const pipelined = await raw(
        port,
        `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${BODY.length}\r\n\r\n` +
            BODY +
            `GET /smuggled HTTP/1.1\r\nHost: x\r\n\r\n`
    );
    assert.strictEqual(answerCount(pipelined), 2, "both pipelined requests must be answered");
    assert.ok(served.includes("GET /smuggled"), "the second pipelined request must reach its route");

    close();
});

test("a content-length that is not a count of bytes never reaches a route", async () => {
    const { port, close, served } = await serve();

    // uWS trims the spaces around the value and then takes whatever is left, so all of these
    // reached a route before, each one framing the request as bodyless
    for (const value of ["abc", "+13", "0x0d", "1 3", "-5", "1e2", "11abc", ""]) {
        const answer = await raw(
            port,
            `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${value}\r\n\r\n${BODY}`
        );
        assert.ok(!answer.includes("200"), `a content-length of "${value}" must not be answered 200`);
    }
    assert.deepStrictEqual(served, [], "and no route may run for any of them");

    close();
});

test("an empty content-length cannot smuggle a second request", async () => {
    const { port, close, served } = await serve();

    // the one uWS answered rather than refusing: it framed the request as carrying no body, so
    // what followed the head was read as a request of its own and served
    const smuggled = `GET /smuggled HTTP/1.1\r\nHost: x\r\n\r\n`;
    const answer = await raw(port, `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: \r\n\r\n${smuggled}`);

    assert.ok(!served.includes("GET /smuggled"), "the smuggled request must never reach a route");
    assert.deepStrictEqual(served, [], "and neither must the request carrying it");
    assert.strictEqual(answer, "", "the connection must be closed without an answer");

    close();
});

test("a padded content-length is still a good one", async () => {
    const { port, close } = await serve();

    // uWS hands the value over already trimmed, and the digits left are a perfectly legal length:
    // the refusal must not have started rejecting these
    for (const value of [" 11", "11 ", "\t11\t", "011"]) {
        const answer = await raw(
            port,
            `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${value}\r\n\r\n${BODY}`
        );
        assert.match(answer, /^HTTP\/1\.1 200 /, `a content-length of "${value}" must still be served`);
        assert.match(answer, /"ok":true/, "and its body must still be parsed");
    }

    close();
});

test("a content-length alongside a transfer-encoding never reaches a route", async () => {
    const { port, close, served } = await serve();

    // the other classic smuggling pair. uWS refuses it, and the native body path skips its length
    // check when the length is missing, so this is the guard that keeps that safe
    const answer = await raw(
        port,
        `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
            `Content-Length: 6\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /smuggled HTTP/1.1\r\nHost: x\r\n\r\n`
    );

    assert.ok(!answer.includes("200"), "a request declaring both framings must not be answered 200");
    assert.deepStrictEqual(served, [], "no route may run");

    close();
});

test("a chunked body with no content-length is still read", async () => {
    const { port, close } = await serve();

    // the shape the native collect path takes when there is no declared length to check against,
    // which is what the refusals above must not have broken
    const answer = await raw(
        port,
        `POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n` +
            `b\r\n${BODY}\r\n0\r\n\r\n`
    );

    assert.match(answer, /^HTTP\/1\.1 200 /);
    assert.match(answer, /"ok":true/, "the chunked body must still be parsed");

    close();
});
