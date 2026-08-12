// What a library handed the result of app.listen() finds when it looks.
//
// The graceful shutdown wrappers, the connection trackers and the health check middlewares do not
// build a server, they recognise one and then use four or five of its members. This pins the
// answers, including the two that are deliberately not node's: getConnections counts requests in
// flight because there are no sockets to count, and nothing emits 'connection'.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const net = require("node:net");
const express = require("../../src/index.js");

test("an application is recognised as a server", () => {
    const app = express();
    assert.ok(app instanceof http.Server, "instanceof http.Server");
    assert.ok(app instanceof net.Server, "instanceof net.Server");
});

test("and nothing else has changed its mind about what a server is", () => {
    const real = http.createServer();
    assert.ok(real instanceof http.Server);
    assert.ok(real instanceof net.Server);
    assert.ok(!(express.Router() instanceof http.Server), "a router is not a server");
    assert.ok(!(function () {} instanceof http.Server), "a plain function is not");
    assert.ok(!({} instanceof http.Server), "a plain object is not");
    assert.ok(!(null instanceof http.Server), "null is not");
    assert.ok(!("" instanceof http.Server), "a primitive is not");
    real.close();
});

test("the members a shutdown wrapper reaches for are all there", () => {
    const app = express();
    for (const name of ["close", "address", "listen", "getConnections", "ref", "unref", "setTimeout", "on", "once"]) {
        assert.strictEqual(typeof (/** @type {any} */ (app)[name]), "function", name);
    }
    assert.strictEqual(app.listening, false);
    assert.strictEqual(app.address(), null, "an unbound server has no address");
    // read and written by libraries working out what they are talking to
    assert.strictEqual(typeof (/** @type {any} */ (app).keepAliveTimeout), "number");
    assert.strictEqual(typeof (/** @type {any} */ (app).headersTimeout), "number");
    assert.strictEqual(/** @type {any} */ (app).maxHeadersCount, null);
    assert.strictEqual(/** @type {any} */ (app).ref(), app, "ref hands the server back");
    assert.strictEqual(/** @type {any} */ (app).unref(), app, "unref hands the server back");
    /** @type {any} */ (app).setTimeout(1234);
    assert.strictEqual(/** @type {any} */ (app).timeout, 1234, "setTimeout remembers what it was given");
});

test("setTimeout registers the listener node's does", () => {
    const app = express();
    let called = false;
    /** @type {any} */ (app).setTimeout(10, () => {
        called = true;
    });
    app.emit("timeout");
    assert.ok(called, "the callback is a 'timeout' listener");
});

test("getConnections counts the requests in flight", async () => {
    const app = express();
    /** @type {any} */
    let held;
    app.get("/hold", (req, res) => {
        held = res;
    });
    app.get("/quick", (req, res) => res.send("ok"));

    const server = app.listen(0);
    const port = app.address().port;
    /** @param {any} target @returns {Promise<number>} */
    const connections = () => new Promise((resolve) => server.getConnections((err, count) => resolve(count)));

    try {
        assert.strictEqual(await connections(), 0, "nothing in flight yet");

        await fetch(`http://127.0.0.1:${port}/quick`).then((res) => res.text());
        assert.strictEqual(await connections(), 0, "an answered request is not in flight");

        const pending = fetch(`http://127.0.0.1:${port}/hold`);
        // the handler runs before the count is taken
        while (held === undefined) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.strictEqual(await connections(), 1, "the held request is counted");

        held.send("done");
        await pending.then((res) => res.text());
        assert.strictEqual(await connections(), 0, "and is gone once it is answered");
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
});

test("a shutdown wrapper written against node drives it", async () => {
    // the shape @godaddy/terminus and stoppable have in common: recognise, wrap close, wait for
    // the connections to reach zero, call back
    const app = express();
    app.get("/", (req, res) => res.send("ok"));
    const server = app.listen(0);
    const port = app.address().port;

    /** @param {any} target @returns {Promise<void>} */
    function shutdown(target) {
        if (!(target instanceof http.Server)) {
            throw new TypeError("not a server");
        }
        return new Promise((resolve, reject) => {
            const closed = target.close((err) => (err ? reject(err) : undefined));
            assert.strictEqual(closed, target, "close hands the server back, as node's does");
            const wait = () =>
                target.getConnections((err, count) => {
                    if (count === 0) {
                        return resolve(undefined);
                    }
                    setTimeout(wait, 5);
                });
            wait();
        });
    }

    const answer = await fetch(`http://127.0.0.1:${port}/`).then((res) => res.text());
    assert.strictEqual(answer, "ok");
    await shutdown(server);
    assert.strictEqual(app.listening, false, "and the server is closed afterwards");
});
