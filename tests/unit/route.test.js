// The Route class behind app.route(), on the paths coverage showed nothing was holding: the
// OPTIONS verb list, HEAD riding a GET handler, the two escape words next() understands, the
// synchronous-chain relief valve and the argument check.

const test = require("node:test");
const assert = require("node:assert");

const express = require("../../src/index.js");

/**
 * Starts an app and answers a fetch helper bound to it.
 *
 * @param {(app: any) => void} setup
 * @returns {Promise<{url: string, close: () => void}>}
 */
function serve(setup) {
    return new Promise((resolve) => {
        const app = express();
        setup(app);
        app.listen(0, () => {
            resolve({ url: `http://localhost:${app.address().port}`, close: () => app.close() });
        });
    });
}

test("OPTIONS lists a route's verbs, HEAD riding along with GET", async () => {
    const { url, close } = await serve((app) => {
        app.route("/thing")
            .get((req, res) => res.send("got"))
            .post((req, res) => res.send("posted"));
    });

    const res = await fetch(`${url}/thing`, { method: "OPTIONS" });
    assert.equal(res.status, 200);
    const allow = String(res.headers.get("allow"));
    for (const verb of ["GET", "HEAD", "POST"]) {
        assert.ok(allow.includes(verb), `${verb} missing from ${allow}`);
    }

    // and the GET handler answers a HEAD without being registered for it
    const head = await fetch(`${url}/thing`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    close();
});

test("next('route') leaves the route, next('router') leaves the router", async () => {
    const { url, close } = await serve((app) => {
        app.route("/skip").get(
            (req, res, next) => next("route"),
            (req, res) => res.send("never: next('route') left this whole stack")
        );
        app.get("/skip", (req, res) => res.send("the later route"));

        const router = express.Router();
        router.route("/out").get((req, res, next) => next("router"));
        router.get("/out", (req, res) => res.send("never: next('router') left the router"));
        app.use("/r", router);
        app.use("/r", (req, res) => res.send("after the router"));
    });

    const skipped = await fetch(`${url}/skip`);
    assert.equal(await skipped.text(), "the later route");

    const out = await fetch(`${url}/r/out`);
    assert.equal(await out.text(), "after the router");
    close();
});

test("a long synchronous chain inside one route completes past the relief valve", async () => {
    const { url, close } = await serve((app) => {
        // well past SYNC_LIMIT, so the chain has to take the setImmediate hop and come back
        const passers = Array.from({ length: 250 }, () => (req, res, next) => next());
        app.route("/long").get(...passers, (req, res) => res.send("made it"));
    });

    const res = await fetch(`${url}/long`);
    assert.equal(await res.text(), "made it");
    close();
});

test("the exported Route class refuses a handler that is not a function, naming what it got", () => {
    const route = /** @type {any} */ (new express.Route("/bad"));
    assert.throws(
        () => route.get("not a function"),
        /Route\.get\(\) requires a callback function but got a \[object String\]/
    );
    assert.throws(() => route.post(null), /Route\.post\(\) requires a callback function but got a \[object Null\]/);
});

test("the exported Route class dispatches, answers verbs and walks its escape words", async () => {
    const route = /** @type {any} */ (new express.Route("/direct"));
    const order = [];
    route.get(
        (req, res, next) => {
            order.push("first");
            next();
        },
        (req, res, next) => {
            order.push("second");
            next();
        }
    );
    route.post((req, res, next) => {
        order.push("posted");
        next();
    });

    // HEAD rides the GET handlers without being registered
    assert.equal(route.handlesMethod("HEAD"), true);
    assert.equal(route.handlesMethod("get"), true);
    assert.equal(route.handlesMethod("PUT"), false);
    assert.deepEqual(route._methods().sort(), ["GET", "HEAD", "POST"]);

    await new Promise((resolve) => route.dispatch({ method: "GET" }, {}, resolve));
    assert.deepEqual(order, ["first", "second"]);

    // next("route") ends this route's stack right there
    order.length = 0;
    const skipping = /** @type {any} */ (new express.Route("/skip"));
    skipping.get(
        (req, res, next) => {
            order.push("ran");
            next("route");
        },
        (req, res, next) => {
            order.push("never");
            next();
        }
    );
    const endedOn = await new Promise((resolve) => skipping.dispatch({ method: "GET" }, {}, resolve));
    assert.deepEqual(order, ["ran"]);
    assert.equal(endedOn, undefined);

    // next("router") ends it too, and the word travels out to whoever ran the route
    const leaving = /** @type {any} */ (new express.Route("/leave"));
    leaving.get((req, res, next) => next("router"));
    const word = await new Promise((resolve) => leaving.dispatch({ method: "GET" }, {}, resolve));
    assert.equal(word, "router");

    // an empty route is done immediately
    const empty = /** @type {any} */ (new express.Route("/empty"));
    await new Promise((resolve) => empty.dispatch({ method: "GET" }, {}, resolve));
});
