// The members node's request and response have that this one cannot honour, called for real.
//
// The comparison suite can only check that they exist: calling writeContinue there would put an
// unsolicited 100 on the wire, which node's own client rejects as a protocol error, and calling
// assignSocket on express with nothing would take the response apart. Here there is no express arm
// to keep in step, so they can be exercised as an application would.

const test = require("node:test");
const assert = require("node:assert");

const express = require("../../src/index.js");

/**
 * Starts an app and answers a fetch helper bound to it.
 *
 * @param {(app: any) => void} setup
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
function serve(setup) {
    return new Promise((resolve) => {
        const app = express();
        setup(app);
        app.listen(0, () => {
            resolve({
                url: `http://localhost:${app.address().port}`,
                // awaited, and not fired and forgotten: close() drains the responses still in
                // flight, so a test that returned without waiting left that drain running under
                // whatever ran next, and the file's process kept the event loop alive
                close: () => new Promise((closed) => app.close(() => closed(undefined)))
            });
        });
    });
}

test("the informational responses are accepted, send nothing, and call back as node does", async () => {
    let calledSynchronously = null;
    const server = await serve((app) => {
        app.get("/", (req, res) => {
            let called = false;
            res.writeEarlyHints({ link: "</main.js>; rel=preload; as=script" }, () => {
                called = true;
            });
            // node writes the hints and calls back afterwards, so it cannot have run yet
            calledSynchronously = called;
            res.writeContinue();
            res.writeProcessing();
            res.addTrailers({ "x-trailing": "nowhere" });
            res.assignSocket(null);
            res.detachSocket(null);
            setImmediate(() => res.json({ calledByThen: called }));
        });
    });

    const body = await fetch(server.url).then((r) => r.json());
    assert.strictEqual(calledSynchronously, false, "the callback must not run synchronously");
    assert.strictEqual(body.calledByThen, true, "and it must have run by the next turn");
    await server.close();
});

test("an informational response after the head has gone out throws, as node's does", async () => {
    const server = await serve((app) => {
        app.get("/", (req, res) => {
            res.write("body;");
            const thrown = [];
            for (const method of ["writeEarlyHints", "writeContinue", "writeProcessing"]) {
                try {
                    res[method]({});
                    thrown.push(`${method}: no throw`);
                } catch (error) {
                    thrown.push(`${method}: ${error.code}`);
                }
            }
            res.end(thrown.join(", "));
        });
    });

    const text = await fetch(server.url).then((r) => r.text());
    assert.strictEqual(
        text,
        "body;writeEarlyHints: ERR_HTTP_HEADERS_SENT, writeContinue: ERR_HTTP_HEADERS_SENT, " +
            "writeProcessing: ERR_HTTP_HEADERS_SENT"
    );
    await server.close();
});

test("the header members node has answer as node's do", async () => {
    const server = await serve((app) => {
        app.get("/", (req, res) => {
            res.setHeader("x-one", "1");
            res.appendHeader("x-one", "2");
            res.appendHeader("x-two", "fresh");
            res.setHeaders(new Map([["x-three", "map"]]));
            res.setHeaders(new Headers({ "x-four": "headers" }));
            res.json({
                one: res.getHeader("x-one"),
                two: res.getHeader("x-two"),
                three: res.getHeader("x-three"),
                four: res.getHeader("x-four"),
                has: res.hasHeader("X-ONE"),
                hasNot: res.hasHeader("x-nothing"),
                raw: res
                    .getRawHeaderNames()
                    .filter((n) => n.startsWith("x-"))
                    .sort()
            });
        });
    });

    const body = await fetch(server.url).then((r) => r.json());
    assert.deepStrictEqual(body, {
        one: ["1", "2"],
        two: "fresh",
        three: "map",
        four: "headers",
        has: true,
        hasNot: false,
        raw: ["x-four", "x-one", "x-three", "x-two"]
    });
    await server.close();
});

test("setTimeout registers the listener and changes nothing else", async () => {
    const server = await serve((app) => {
        app.get("/", (req, res) => {
            let responseHeard = false;
            let requestHeard = false;
            assert.strictEqual(
                res.setTimeout(1000, () => (responseHeard = true)),
                res
            );
            assert.strictEqual(
                req.setTimeout(1000, () => (requestHeard = true)),
                req
            );
            // µWS runs its own idle timeout and this cannot reach it, so nothing fires on its own:
            // what is promised is that the listener was registered
            res.emit("timeout");
            req.emit("timeout");
            res.json({ responseHeard, requestHeard });
        });
    });

    assert.deepStrictEqual(await fetch(server.url).then((r) => r.json()), {
        responseHeard: true,
        requestHeard: true
    });
    await server.close();
});

test("req.signal is one object, and aborts when the client goes away", async () => {
    let signalOfAGoneClient = null;
    // the answer nobody is waiting for any more, kept so this test can put it down rather than
    // leave it to fire under whatever runs next: it holds a response µWS has not finished, which
    // is exactly what close() below waits for
    let tooLate = null;
    const server = await serve((app) => {
        app.get("/stays", (req, res) => {
            assert.strictEqual(req.signal, req.signal, "asked twice, the same signal");
            assert.strictEqual(req.signal.aborted, false);
            assert.deepStrictEqual(req.trailers, {});
            assert.deepStrictEqual(req.trailersDistinct, {});
            res.end("ok");
        });
        app.get("/leaves", (req, res) => {
            signalOfAGoneClient = req.signal;
            tooLate = setTimeout(() => res.end("too late"), 2000);
        });
    });

    assert.strictEqual(await fetch(`${server.url}/stays`).then((r) => r.text()), "ok");

    const controller = new AbortController();
    const abandoned = fetch(`${server.url}/leaves`, { signal: controller.signal }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await abandoned;
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(signalOfAGoneClient?.aborted, true, "the render should learn it was for nobody");
    clearTimeout(tooLate);
    await server.close();
});
