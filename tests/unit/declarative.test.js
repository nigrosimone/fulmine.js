// The declarative compiler's refusals, pinned one shape per bail. The design contract is that
// any handler the compiler does not fully understand falls back to ordinary routing, so every
// case here must answer false rather than compile something wrong or throw.

const test = require("node:test");
const assert = require("node:assert");

const compileDeclarative = require("../../src/declarative.js");
const express = require("../../src/index.js");

// etag off, because a response that would carry one is not compiled at all: µWS cannot read the
// request, so it could never answer the conditional GET the validator invites. The test below
// pins that, and every other test here is about a different refusal.
const app = express();
app.set("etag", false);

test("what the compiler accepts compiles into a declarative response", () => {
    // a compiled route is uWS's DeclarativeResponse, an object handed to the registration
    const compiled = compileDeclarative((req, res) => res.send("hello"), app);
    assert.ok(compiled && typeof compiled === "object", String(compiled));
    assert.ok(compileDeclarative((req, res) => res.status(201).send("made"), app));
    // a media type is a lookup on a literal, and set() takes an object as well as a pair
    assert.ok(compileDeclarative((req, res) => res.type("json").send("{}"), app));
    assert.ok(compileDeclarative((req, res) => res.set({ server: "fulmine" }).send("ok"), app));
    // setHeader is node's and throws on an object, so the compiler refuses it there
    assert.ok(!compileDeclarative((req, res) => res.setHeader({ server: "fulmine" }).send("ok"), app));
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
        // req.body is read from the socket, which a compiled response never waits for. req.query
        // and req.params are not here: µWS interpolates those itself, see the test below
        (req, res) => res.send(req.body.a),
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

// The opcodes uWS interprets, and their operands, so a test can read a compiled response back
const OPCODES = {
    0: "END",
    1: "WRITE_HEADER",
    2: "WRITE_BODY",
    3: "QUERY",
    4: "HEADER",
    5: "WRITE",
    6: "PARAM",
    7: "STATUS"
};

/** @param {ArrayBuffer} compiled @returns {{op: string, value: string}[]} */
function decode(compiled) {
    const bytes = new Uint8Array(compiled);
    const out = [];
    let at = 0;
    const text = (from, length) => Buffer.from(bytes.slice(from, from + length)).toString();
    while (at < bytes.length) {
        const op = OPCODES[bytes[at]];
        if (op === "END" || op === "WRITE") {
            const length = bytes[at + 1] | (bytes[at + 2] << 8);
            out.push({ op, value: text(at + 3, length) });
            at += 3 + length;
        } else if (op === "WRITE_HEADER") {
            const keyLength = bytes[at + 1];
            const valueLength = bytes[at + 2 + keyLength];
            out.push({ op, value: text(at + 2, keyLength) });
            at += 3 + keyLength + valueLength;
        } else if (op === "WRITE_BODY") {
            out.push({ op, value: "" });
            at += 1;
        } else {
            const keyLength = bytes[at + 1];
            out.push({ op, value: text(at + 2, keyLength) });
            at += 2 + keyLength;
        }
    }
    return out;
}

test("a literal body is one end(), so uWS frames it with a Content-Length", () => {
    // uWS chunks a response written in pieces and gives a length to one that arrives whole, and
    // that is the only way either header can be set here: it writes the framing itself
    const body = decode(compileDeclarative((req, res) => res.send("hello"), app)).filter(
        (instruction) => instruction.op === "END" || instruction.op === "WRITE"
    );
    assert.deepStrictEqual(body, [{ op: "END", value: "hello" }]);

    // json is the same, and so is a body the compiler assembles from more than one literal
    const json = decode(compileDeclarative((req, res) => res.json({ ok: true }), app)).filter(
        (instruction) => instruction.op === "END" || instruction.op === "WRITE"
    );
    assert.deepStrictEqual(json, [{ op: "END", value: '{"ok":true}' }]);
});

test("a body with a piece of the request in it stays written in pieces", () => {
    // its length is not known until the request arrives, so uWS has to chunk it. Only reachable
    // with etag off: an ETag cannot be computed over a body this side has not seen yet
    const noEtag = express();
    noEtag.set("etag", false);
    const parts = decode(compileDeclarative((req, res) => res.send("id " + req.params.id), noEtag)).filter(
        (instruction) => ["END", "WRITE", "PARAM", "QUERY"].includes(instruction.op)
    );
    assert.deepStrictEqual(parts, [
        { op: "WRITE", value: "id " },
        { op: "PARAM", value: "id" },
        { op: "END", value: "" }
    ]);
});

test("a response that would carry a validator is not compiled, since it could never honour one", () => {
    // µWS answers a compiled response without reading the request, so a conditional GET carrying
    // the tag is answered 200 with the whole body where Express answers 304. This used to compile
    // and write an ETag computed over the body at listen, which was then ignored on every
    // revalidation. Refusing keeps Express's answer; `etag` false is how a route stays compiled.
    const withEtag = express();
    assert.strictEqual(withEtag.get("etag"), "weak");
    assert.ok(!compileDeclarative((req, res) => res.send("hello"), withEtag));
    assert.ok(!compileDeclarative((req, res) => res.json({ ok: true }), withEtag));
    // Express computes the tag over the body it was about to send and keeps it on a status that
    // carries none, so these are refused too rather than treated as bodiless
    assert.ok(!compileDeclarative((req, res) => res.sendStatus(204), withEtag));
    assert.ok(!compileDeclarative((req, res) => res.status(201).send("made"), withEtag));
    // nothing to lose: no body, so no validator on either path
    assert.ok(compileDeclarative((req, res) => res.end(), withEtag));

    // with etag off the same handlers compile, and nothing writes a validator into them
    const headers = decode(compileDeclarative((req, res) => res.send("hello"), app))
        .filter((instruction) => instruction.op === "WRITE_HEADER")
        .map((instruction) => instruction.value.toLowerCase());
    assert.ok(!headers.includes("etag"), headers.join(", "));
    assert.ok(!headers.includes("last-modified"), headers.join(", "));

    // and a handler that sets one itself is refused even then, since writing it through would
    // advertise the same thing this side cannot answer
    assert.ok(!compileDeclarative((req, res) => res.set("ETag", '"abc"').send("hi"), app));
    assert.ok(!compileDeclarative((req, res) => res.set("etag", '"abc"').send("hi"), app));
    assert.ok(!compileDeclarative((req, res) => res.set("Last-Modified", "x").send("hi"), app));
    // the same handler without the validator still compiles, so the refusal is the header's doing
    assert.ok(compileDeclarative((req, res) => res.set("x-other", "abc").send("hi"), app));
});
