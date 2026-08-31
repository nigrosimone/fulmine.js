// The handle a route layer carries, called directly.
//
// router.stack is walked by libraries that list endpoints and by tests that pull one handler out by
// name, and both of those only read. A caller that goes further and calls the layer itself is rarer
// but it is what express hands them, so the handle runs the route's own callbacks in order and
// hands an error to the ones written to take one. routers/router-stack.js is the other half: it
// compares the shape of the whole stack against express.

const test = require("node:test");
const assert = require("node:assert");

const express = require("../../src/index.js");

const noop = () => {};

test("the handle runs the route's callbacks one after another", () => {
    const router = express.Router();
    const seen = [];
    router.get(
        "/x",
        (req, res, next) => {
            seen.push("first");
            next();
        },
        (req, res) => {
            seen.push("second");
            res.done = true;
        }
    );

    const layer = router.stack[0];
    assert.strictEqual(layer.name, "handle");
    const res = {};
    layer.handle({}, res, noop);
    assert.deepStrictEqual(seen, ["first", "second"]);
    assert.strictEqual(res.done, true);
});

test("running out of callbacks leaves the layer through next", () => {
    const router = express.Router();
    router.get("/x", (req, res, next) => next());

    let left = "not called";
    router.stack[0].handle({}, {}, (err) => (left = err));
    assert.strictEqual(left, undefined, "left with nothing, which is how a layer says it is done");
});

test("a throw becomes the error the next callback is given", () => {
    const router = express.Router();
    const seen = [];
    router.get(
        "/x",
        () => {
            throw new Error("boom");
        },
        (req, res, next) => seen.push("skipped, this one does not take an error"),
        (err, req, res, next) => {
            seen.push("handled: " + err.message);
            next(err);
        }
    );

    let left;
    router.stack[0].handle({}, {}, (err) => (left = err));
    assert.deepStrictEqual(seen, ["handled: boom"]);
    assert.strictEqual(left.message, "boom", "and it carries on out of the layer");
});

test("an error handed to the layer skips straight to the one written for it", () => {
    const router = express.Router();
    const seen = [];
    router.get(
        "/x",
        (req, res, next) => seen.push("plain"),
        (err, req, res, next) => next(err)
    );
    router.get("/y", (req, res, next) => seen.push("second route"));

    // two routes, two layers, and the second one is a route of its own rather than a callback of
    // the first: this is the shape express builds and the walk has to match it
    assert.strictEqual(router.stack.length, 2);
    assert.strictEqual(router.stack[0].route.path, "/x");
    assert.strictEqual(router.stack[1].route.path, "/y");
});
