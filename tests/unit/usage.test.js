// Which handlers the header-skip analysis trusts, pinned so that a verdict quietly flipping is
// a failing test in both directions: a handler wrongly trusted would see a request with its
// headers missing, and a handler wrongly distrusted costs the copy it was meant to save.
//
// The comparison suite cannot see this: a skipped copy answers with the same bytes, only
// faster, and a wrongly granted skip only shows on the exact header a handler happens to read.

const test = require("node:test");
const assert = require("node:assert");

const { callbackSkipsHeaders, chainSkipsHeaders } = require("../../src/usage.js");
const express = require("../../src/index.js");

const NO = 0;
const SAFE = 1;
const SAFE_NEXT = 2;

test("what a single callback is allowed to do", () => {
    // the plain benchmark shapes
    assert.equal(
        callbackSkipsHeaders((req, res) => res.send("hi")),
        SAFE
    );
    assert.equal(
        callbackSkipsHeaders((req, res) => res.status(200).json({ id: req.params.id, q: req.query.name })),
        SAFE
    );
    assert.equal(
        callbackSkipsHeaders(function (req, res) {
            res.type("text/plain");
            res.end(req.method + " " + req.path);
        }),
        SAFE
    );
    // advancing the chain is fine, mid-chain
    assert.equal(
        callbackSkipsHeaders((req, res, next) => next()),
        SAFE_NEXT
    );
    assert.equal(
        callbackSkipsHeaders((req, res, next) => next(new Error("boom"))),
        SAFE_NEXT
    );

    // everything below must keep the header copy
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
        (req, res) => res.send(req["hea" + "ders"]) // computed access is unreadable
    ];
    for (const fn of distrusted) {
        assert.equal(callbackSkipsHeaders(fn), NO, fn.toString());
    }

    // the body parsers carry the mark instead of being read
    assert.equal(callbackSkipsHeaders(express.json()), SAFE_NEXT);
    assert.equal(callbackSkipsHeaders(express.urlencoded({ extended: false })), SAFE_NEXT);
    // a type function sees the request itself, so the mark is withheld
    assert.equal(callbackSkipsHeaders(express.json({ type: (req) => true })), NO);
});

test("a chain is judged whole, and the terminal next needs a clear path behind it", () => {
    const safe = { callbacks: [(req, res) => res.send("x")], paramCallbacks: new Map() };
    const mid = { callbacks: [(req, res, next) => next()], paramCallbacks: new Map() };
    const reads = { callbacks: [(req, res) => res.send(req.get("h"))], paramCallbacks: new Map() };

    assert.equal(chainSkipsHeaders([mid, safe], false), true);
    assert.equal(chainSkipsHeaders([mid, reads], false), false);
    // a terminal that calls next may fall through, so it needs the all-clear
    assert.equal(chainSkipsHeaders([safe, mid], false), false);
    assert.equal(chainSkipsHeaders([safe, mid], true), true);
    // a param callback is code nobody analyzed
    const withParam = { callbacks: [(req, res) => res.send("x")], paramCallbacks: new Map([["id", []]]) };
    assert.equal(chainSkipsHeaders([withParam], false), false);
});

/**
 * Starts an app and answers how many native presets were granted the skip.
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

    // anything registered after listen could catch a throw or a fall-through
    off.app.use((req, res) => res.status(404).end());
    assert.equal(off.app._skipPresets.size, 0);
    off.close();

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
