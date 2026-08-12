// express.testing: the verdicts npx fulmine profile prints, as assertions.
//
// The failures are the product here, so most of these read the message: a test that says a route
// left the fast path has to say which route and why, or the person reading CI learns nothing.

const test = require("node:test");
const assert = require("node:assert");
const express = require("../../src/index.js");
const { expectNative, expectDeclarative, routeReport } = require("../../src/index.js").testing;

/** An application with one of each: compiled, native, and fallen back to the router. */
function build() {
    const app = express();
    // simple enough to be read at registration time
    app.get("/health", (req, res) => res.send("ok"));
    // native, but the handler is not compilable
    app.get("/users/:id", (req, res) => res.json({ id: req.params.id, at: Date.now() }));
    // a parameter route written first is what pushes the literal below it off the native path
    app.get("/api/:anything", (req, res) => res.send("param"));
    app.get("/api/late", (req, res) => res.send("late"));
    return app;
}

test("the report says what happened to every route", () => {
    const report = routeReport(build());
    assert.deepStrictEqual(
        report.map((entry) => `${entry.method} ${entry.path}`),
        ["GET /health", "GET /users/:id", "GET /api/:anything", "GET /api/late"]
    );
    const health = report[0];
    assert.ok(health.native && health.declarative, "a simple handler is compiled into a response");
    const users = report[1];
    assert.ok(users.native && !users.declarative, "a real handler is native without being compiled");
    const late = report[3];
    assert.ok(!late.native, "the literal written under a parameter route falls back");
    assert.match(late.reason, /parameter route/, "and says why");
});

test("expectNative passes for the routes µWS answers", () => {
    const app = build();
    expectNative(app, "/health");
    expectNative(app, ["GET /health", "/users/:id"]);
    // a prefix names everything under it
    expectNative(app, "/users*");
});

test("expectNative fails with the route and the reason", () => {
    const app = build();
    assert.throws(
        () => expectNative(app, "/api/late"),
        (err) => {
            assert.match(err.message, /1 route\(s\) are no longer answered/);
            assert.match(err.message, /GET \/api\/late/);
            assert.match(err.message, /parameter route/, "the reason is in the message");
            assert.match(err.message, /fulmine profile/, "and where to look next");
            return true;
        }
    );
});

test("a prefix that covers a lost route fails too, and names only that one", () => {
    const app = build();
    assert.throws(
        () => expectNative(app, "/api*"),
        (err) => {
            assert.match(err.message, /1 route\(s\)/);
            // one route listed, and it is the one that fell back. /api/:anything appears in the
            // message too, but as the reason rather than as a listing of its own
            const listed = err.message.split("\n").filter((/** @type {string} */ line) => /^ {2}GET /.test(line));
            assert.deepStrictEqual(listed, ["  GET /api/late"]);
            return true;
        }
    );
});

test("a pattern that names no route is a failure, not a pass", () => {
    const app = build();
    assert.throws(
        () => expectNative(app, "/typo"),
        (err) => {
            assert.match(err.message, /no route is registered as "\/typo"/);
            assert.match(err.message, /GET \/health/, "the paths it does have are listed");
            return true;
        }
    );
    assert.throws(() => expectNative(app, []), /needs a path/);
});

test("the method can be pinned", () => {
    const app = express();
    app.get("/thing", (req, res) => res.send("get"));
    app.post("/thing", (req, res) => res.json({ ok: true }));
    expectNative(app, ["GET /thing", "POST /thing"]);
    assert.throws(() => expectNative(app, "PUT /thing"), /no route is registered/);
});

test("expectDeclarative is the step past native", () => {
    const app = build();
    expectDeclarative(app, "/health");
    assert.throws(
        () => expectDeclarative(app, "/users/:id"),
        (err) => {
            assert.match(err.message, /no longer compiled into a response/);
            assert.match(err.message, /answered by µWS, but the handler is no longer simple enough/);
            return true;
        }
    );
});

test("a listening application is read without being compiled twice", async () => {
    const app = build();
    const server = app.listen(0);
    try {
        expectNative(app, "/health");
        const answer = await fetch(`http://127.0.0.1:${app.address().port}/health`).then((res) => res.text());
        assert.strictEqual(answer, "ok", "and it still answers");
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
});
