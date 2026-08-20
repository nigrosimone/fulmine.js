// The lazy request and the lazy response, over a real server rather than over a stub.
//
// lazy-readable.test.js and lazy-writable.test.js check that the doors are guarded. This checks the
// other half, which is the half that regresses: that walking the ordinary routes does not open any
// of them. Building the Readable, the Writable, the folded headers object or the socket stand-in
// costs about a fifth of a hello-world between them, and losing one of them fails nothing: the
// answer is the same answer, only slower, and the commit that did it is found weeks later.
//
// The report is read after the response is over, so it covers send() and end() as well as the
// chain, and the last few cases are here to prove the check can fail at all.

const test = require("node:test");
const assert = require("node:assert");
const express = require("../../src/index.js");
const { workReport, expectLazy } = require("../../src/index.js").testing;

/**
 * The request and the response the next request will arrive on, taken from the constructor rather
 * than from a middleware: a middleware in front of the routes is a different chain from the one
 * being measured, and there is none to put in front of a 404 anyway.
 *
 * @param {any} app
 * @returns {{req: any, res: any}}
 */
function watch(app) {
    /** @type {any} */
    const seen = { req: null, res: null };
    const Request = app._request;
    const Response = app._response;
    app._request = class extends Request {
        /** @param {...any} args */
        constructor(...args) {
            super(...args);
            seen.req = this;
        }
    };
    app._response = class extends Response {
        /** @param {...any} args */
        constructor(...args) {
            super(...args);
            seen.res = this;
        }
    };
    return seen;
}

/**
 * Runs one request against an application and hands back what the request was made to do, read
 * once it is over, so it covers send() and end() as well as the chain.
 *
 * @param {(app: any) => void} setup
 * @param {string} path
 * @param {object} [init]
 * @returns {Promise<{done: any, req: any, res: any, status: number, body: string}>}
 */
async function ask(setup, path, init) {
    const app = express();
    app.set("etag", false);
    // A route compiled into a response is answered by µWS without entering javascript, so there is
    // no request object to ask and nothing to measure. Off here, which leaves the routes native
    // with their granted skips intact: that is the fastest path anything below can be asked about.
    app.set("declarative responses", false);
    setup(app);
    const seen = watch(app);
    const server = app.listen(0);
    try {
        const res = await fetch(`http://127.0.0.1:${app.address().port}${path}`, init);
        const body = await res.text();
        return { done: workReport(seen.req, seen.res), req: seen.req, res: seen.res, status: res.status, body };
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
}

test("a hello world builds neither stream, nor the headers, nor a socket", async () => {
    const answer = await ask((app) => {
        app.get("/hello", (req, res) => res.send("ok"));
    }, "/hello");
    assert.strictEqual(answer.body, "ok");
    assert.deepStrictEqual(answer.done, {
        native: true,
        declarative: false,
        headers: false,
        query: false,
        body: false,
        requestStream: false,
        responseStream: false,
        socket: false
    });
    expectLazy(answer.req, answer.res);
});

test("res.json, res.status and res.set stay on the same side of it", async () => {
    const answer = await ask((app) => {
        app.get("/thing/:id", (req, res) => {
            res.status(201).set("x-thing", req.params.id).json({ id: req.params.id });
        });
    }, "/thing/7");
    assert.strictEqual(answer.status, 201);
    expectLazy(answer.req, answer.res);
});

test("reading the query parses the query and builds nothing else", async () => {
    const answer = await ask((app) => {
        app.get("/search", (req, res) => res.send(String(req.query.q)));
    }, "/search?q=fulmine");
    assert.strictEqual(answer.body, "fulmine");
    assert.strictEqual(answer.done.query, true);
    expectLazy(answer.req, answer.res, { allow: ["query"] });
});

test("the extended parser is reported too, and still answers twice the same", async () => {
    const answer = await ask((app) => {
        app.set("query parser", "extended");
        app.get("/search", (req, res) => res.send(JSON.stringify([req.query.a, req.query.a])));
    }, "/search?a[b]=1");
    assert.strictEqual(answer.body, '[{"b":"1"},{"b":"1"}]');
    assert.strictEqual(answer.done.query, true, "a parser that keeps no snapshot still says it parsed");
    expectLazy(answer.req, answer.res, { allow: ["query"] });
});

test("a json body is read from µWS, so the request never becomes a Readable", async () => {
    const answer = await ask(
        (app) => {
            app.use(express.json());
            app.post("/items", (req, res) => res.json(req.body));
        },
        "/items",
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ a: 1 })
        }
    );
    assert.strictEqual(answer.body, '{"a":1}');
    assert.strictEqual(answer.done.requestStream, false, "the body was read through onData, not through the stream");
    // and the three headers the parser asks for go through the raw entries: reading a header by
    // name is not reading req.headers, and only the second builds the object
    assert.strictEqual(answer.done.headers, false);
    expectLazy(answer.req, answer.res, { allow: ["body"] });
});

test("an urlencoded body is read the same way", async () => {
    const answer = await ask(
        (app) => {
            app.use(express.urlencoded({ extended: false }));
            app.post("/form", (req, res) => res.send(String(req.body.name)));
        },
        "/form",
        {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "name=simone"
        }
    );
    assert.strictEqual(answer.body, "simone");
    assert.strictEqual(answer.done.requestStream, false);
    expectLazy(answer.req, answer.res, { allow: ["body"] });
});

test("a 404 the framework writes itself builds nothing either", async () => {
    const answer = await ask(() => {}, "/nowhere");
    assert.strictEqual(answer.status, 404);
    expectLazy(answer.req, answer.res);
});

test("reading req.headers is what the check is for", async () => {
    const answer = await ask((app) => {
        app.get("/host", (req, res) => res.send(String(req.headers.host)));
    }, "/host");
    assert.strictEqual(answer.done.headers, true);
    assert.throws(() => expectLazy(answer.req, answer.res), /did work a fast request does not: headers/);
});

test("writing the response in pieces is what builds the Writable", async () => {
    const answer = await ask((app) => {
        app.get("/pieces", (req, res) => {
            res.write("one ");
            res.end("two");
        });
    }, "/pieces");
    assert.strictEqual(answer.body, "one two");
    assert.strictEqual(answer.done.responseStream, true);
    assert.throws(() => expectLazy(answer.req, answer.res), /res stream/);
});

test("expectLazy refuses a field it does not know, rather than passing on it", async () => {
    const answer = await ask((app) => {
        app.get("/hello", (req, res) => res.send("ok"));
    }, "/hello");
    assert.throws(() => expectLazy(answer.req, answer.res, { allow: ["streams"] }), /is not one of/);
});
