// Which handlers the usage analysis trusts and with what, pinned so a verdict quietly
// flipping is a failing test in both directions: a handler wrongly trusted would see a
// request with its headers or query missing, and one wrongly distrusted costs the work the
// skip was meant to save.
//
// The comparison suite cannot see this: a skipped copy answers with the same bytes, only
// faster, and a wrongly granted skip only shows on the exact thing a handler happens to read.

const test = require("node:test");
const assert = require("node:assert");

const { callbackUsage, chainUsage, UNKNOWN, NEXT_PLAIN, NEXT_ERROR, QUERY } = require("../../src/usage.js");
const express = require("../../src/index.js");

test("what a single callback is allowed to do", () => {
    // the plain benchmark shapes
    assert.equal(
        callbackUsage((req, res) => res.send("hi")),
        0
    );
    assert.equal(
        callbackUsage((req, res) => res.status(200).json({ id: req.params.id, q: req.query.name })),
        QUERY
    );
    assert.equal(
        callbackUsage(function (req, res) {
            res.type("text/plain");
            res.end(req.method + " " + req.path);
        }),
        0
    );
    // reading the url carries the query with it
    assert.equal(
        callbackUsage((req, res) => res.send(req.url)),
        QUERY
    );
    // advancing the chain is fine, mid-chain
    assert.equal(
        callbackUsage((req, res, next) => next()),
        NEXT_PLAIN
    );
    assert.equal(
        callbackUsage((req, res, next) => next(new Error("boom"))),
        NEXT_ERROR
    );

    // everything below must keep the copies
    const distrusted = [
        (req, res) => res.send(req.get("x-a")), // reads a header
        (req, res) => res.send(req.headers["x-a"]), // reads them all
        (req, res) => res.format({ json: () => res.json({}) }), // negotiates against accept
        (req, res) => res.redirect("/elsewhere"), // negotiates the redirect body
        (req, res) => res.send(req.fresh ? "f" : "s"), // freshness is headers
        (req, res, next) => next("route"), // leaves the chain for unanalyzed routes
        (req, res, next) => setTimeout(next, 1), // aliases the continuation
        (req, res) => res.send(JSON.stringify(req)), // aliases the request
        ({ query }, res) => res.json(query), // destructuring aliases it too
        (req, res) => req.res.send("hi"), // reaches res through req, and vice versa
        (req, res) => res.req && res.send("hi"),
        (req, res) => res.send(req["hea" + "ders"]), // computed access is unreadable
        // a rewrite re-enters routing and lands on routes nobody analyzed
        (req, res, next) => {
            req.url = "/elsewhere";
            next();
        },
        (req, res, next) => {
            req.method = "POST";
            next();
        },
        (req, res) => {
            delete req.path;
            res.end();
        }
    ];
    for (const fn of distrusted) {
        assert.ok(callbackUsage(fn) & UNKNOWN, fn.toString());
    }

    // writing a value member is not a rewrite
    assert.equal(
        callbackUsage((req, res) => {
            req.body = { seeded: true };
            res.end();
        }),
        0
    );

    // the body parsers carry the mark instead of being read
    assert.equal(callbackUsage(express.json()), NEXT_PLAIN);
    assert.equal(callbackUsage(express.urlencoded({ extended: false })), NEXT_PLAIN);
    // a type function sees the request itself, so the mark is withheld
    assert.ok(callbackUsage(express.json({ type: (req) => true })) & UNKNOWN);
});

test("a chain is judged whole, and the terminal next needs a clear path behind it", () => {
    const safe = { callbacks: [(req, res) => res.send("x")], paramCallbacks: new Map() };
    const mid = { callbacks: [(req, res, next) => next()], paramCallbacks: new Map() };
    const reads = { callbacks: [(req, res) => res.send(req.get("h"))], paramCallbacks: new Map() };
    const query = { callbacks: [(req, res) => res.json(req.query)], paramCallbacks: new Map() };

    assert.deepEqual(chainUsage([mid, safe], false), { skipHeaders: true, skipQuery: true });
    assert.deepEqual(chainUsage([mid, reads], false), { skipHeaders: false, skipQuery: false });
    // a query read anywhere keeps the query and only the query
    assert.deepEqual(chainUsage([mid, query], false), { skipHeaders: true, skipQuery: false });
    // a terminal that calls next may fall through, so it needs the all-clear
    assert.deepEqual(chainUsage([safe, mid], false), { skipHeaders: false, skipQuery: false });
    assert.deepEqual(chainUsage([safe, mid], true), { skipHeaders: true, skipQuery: true });
    // a param callback is code nobody analyzed
    const withParam = { callbacks: [(req, res) => res.send("x")], paramCallbacks: new Map([["id", []]]) };
    assert.deepEqual(chainUsage([withParam], false), { skipHeaders: false, skipQuery: false });
});

/**
 * Starts an app and answers how many native presets were granted a skip.
 *
 * @param {(app: any) => void} setup
 * @returns {Promise<{app: any, granted: number, close: () => void}>}
 */
function granted(setup) {
    return new Promise((resolve) => {
        const app = express();
        setup(app);
        app.listen(0, () => {
            resolve({ app, granted: app._skipPresets ? app._skipPresets.size : 0, close: () => app.close() });
        });
    });
}

test("the app grants skips only with etag off and takes them back on late registrations", async () => {
    // etag defaults on, so send would consult freshness headers: nothing may skip
    const def = await granted((app) => {
        app.get("/a", (req, res) => res.send("a"));
    });
    assert.equal(def.granted, 0);
    def.close();

    const off = await granted((app) => {
        app.set("etag", false);
        // not declarative-eligible on purpose, so all four registrations carry presets
        app.get("/a", (req, res) => res.send("a" + req.path));
    });
    assert.equal(off.granted, 4);
    for (const preset of off.app._skipPresets) {
        assert.equal(preset.skipHeaders, true);
        assert.equal(preset.skipQuery, true);
    }

    // anything registered after listen could catch a throw or a fall-through
    off.app.use((req, res) => res.status(404).end());
    assert.equal(off.app._skipPresets.size, 0);
    off.close();

    // a query reader keeps the query fetch and sheds only the header copy
    const q = await granted((app) => {
        app.set("etag", false);
        app.get("/q", (req, res) => res.send("q" + (req.query.x || "")));
    });
    assert.equal(q.granted, 4);
    for (const preset of q.app._skipPresets) {
        assert.equal(preset.skipHeaders, true);
        assert.equal(preset.skipQuery, false);
    }
    q.close();

    // an error middleware anywhere forbids every skip up front
    const withErr = await granted((app) => {
        app.set("etag", false);
        app.get("/a", (req, res) => res.send("a" + req.path));
        app.use((err, req, res, next) => res.status(500).end());
    });
    assert.equal(withErr.granted, 0);
    withErr.close();

    // turning etags on after listen takes the skips back too
    const late = await granted((app) => {
        app.set("etag", false);
        app.get("/a", (req, res) => res.send("a" + req.path));
    });
    assert.equal(late.granted, 4);
    late.app.set("etag", true);
    assert.equal(late.app._skipPresets.size, 0);
    late.close();

    // a parameterised native route has no preset, so the skip rides a holder of its own:
    // one for the shared GET handler and one per HEAD twin
    const params = await granted((app) => {
        app.set("etag", false);
        app.get("/u/:id", (req, res) => res.json({ id: req.params.id }));
    });
    assert.equal(params.granted, 3);
    params.close();
});
