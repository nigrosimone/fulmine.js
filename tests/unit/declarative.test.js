// The declarative compiler's refusals, pinned one shape per bail. The design contract is that
// any handler the compiler does not fully understand falls back to ordinary routing, so every
// case here must answer false rather than compile something wrong or throw.

const test = require("node:test");
const assert = require("node:assert");

const compileDeclarative = require("../../src/declarative.js");
const express = require("../../src/index.js");

const app = express();

test("what the compiler accepts compiles into a declarative response", () => {
    // a compiled route is uWS's DeclarativeResponse, an object handed to the registration
    const compiled = compileDeclarative((req, res) => res.send("hello"), app);
    assert.ok(compiled && typeof compiled === "object", String(compiled));
    assert.ok(compileDeclarative((req, res) => res.status(201).send("made"), app));
    assert.ok(compileDeclarative((req, res) => res.sendStatus(204), app));
    assert.ok(compileDeclarative((req, res) => res.end(), app));
    // return res.send(...) as the last statement describes the same response
    assert.ok(
        compileDeclarative(function (req, res) {
            return res.send("returned");
        }, app)
    );
});

test("every shape the compiler cannot vouch for is a refusal, never a throw", () => {
    const refused = [
        // control flow and bindings are the forbidden tokens
        (req, res) => {
            if (Math.random() > 0.5) res.send("a");
            else res.send("b");
        },
        (req, res) => {
            const body = "x";
            res.send(body);
        },
        (req, res) => {
            for (let i = 0; i < 2; i++) res.write("x");
            res.end();
        },
        (req, res) => {
            try {
                res.send("a");
            } catch (e) {
                res.end();
            }
        },
        (req, res) => {
            throw new Error("no");
        },
        async (req, res) => {
            await Promise.resolve();
            res.send("a");
        },
        // fewer than (req, res)
        (req) => {},
        // a return that is not the last statement compiles statements that never run
        (req, res) => {
            return res.send("early");
            // eslint-disable-next-line no-unreachable
            res.end();
        },
        // dynamic values are not literals
        (req, res) => res.send(req.query.a),
        (req, res) => res.send("a" + Math.random()),
        // methods outside the declarative surface
        (req, res) => res.jsonp({ a: 1 }),
        (req, res) => res.sendFile("/etc/passwd"),
        // next is not a response
        (req, res, next) => next(),
        // no response written at all: Express leaves the request waiting, so compiling this
        // to an empty 200 was a live divergence until 2026-08-05
        (req, res) => {},
        // headers without a send are still not a response
        (req, res) => res.set("x-a", "b")
    ];
    for (const fn of refused) {
        assert.equal(compileDeclarative(fn, app), false, fn.toString());
    }

    // an unreadable source is a refusal too
    const lying = (req, res) => res.send("hi");
    lying.toString = () => "42";
    assert.equal(compileDeclarative(lying, app), false);
    class Controller {
        handle(req, res) {
            res.send("hi");
        }
    }
    assert.equal(compileDeclarative(new Controller().handle, app), false);
});
