// The "etag methods" setting is the method gate issue #10 asked for, as an opt-in: unset, every
// method earns a generated ETag exactly as express's suite asserts per method; naming methods
// skips the digest on the others. Only generation is gated, a validator set by hand still goes out.

const test = require("node:test");
const assert = require("node:assert");

const express = require("../../src/index.js");

function serve(setup) {
    return new Promise((resolve) => {
        const app = express();
        setup(app);
        app.listen(0, () => {
            resolve({ url: `http://localhost:${app.address().port}`, close: () => app.close() });
        });
    });
}

test("unset, every method earns a generated ETag, as on express", async () => {
    const { url, close } = await serve((app) => {
        app.post("/x", (req, res) => res.send("body"));
    });

    const posted = await fetch(`${url}/x`, { method: "POST" });
    assert.match(String(posted.headers.get("etag")), /^W\//);

    close();
});

test("named methods keep the ETag, the others skip the digest", async () => {
    const { url, close } = await serve((app) => {
        // lowercased on purpose: the setting uppercases what it is given
        app.set("etag methods", ["get", "head"]);
        app.get("/x", (req, res) => res.send("body"));
        app.post("/x", (req, res) => res.send("body"));
        app.post("/manual", (req, res) => res.set("etag", '"mine"').send("body"));
    });

    const got = await fetch(`${url}/x`);
    assert.match(String(got.headers.get("etag")), /^W\//);

    const head = await fetch(`${url}/x`, { method: "HEAD" });
    assert.match(String(head.headers.get("etag")), /^W\//);

    const posted = await fetch(`${url}/x`, { method: "POST" });
    assert.strictEqual(posted.headers.get("etag"), null);

    const manual = await fetch(`${url}/manual`, { method: "POST" });
    assert.strictEqual(manual.headers.get("etag"), '"mine"');

    close();
});

test("setting it back to null returns to express's behaviour, and junk throws", async () => {
    const { url, close } = await serve((app) => {
        app.set("etag methods", ["GET"]);
        app.set("etag methods", null);
        app.post("/x", (req, res) => res.send("body"));
    });

    const posted = await fetch(`${url}/x`, { method: "POST" });
    assert.match(String(posted.headers.get("etag")), /^W\//);

    assert.throws(() => express().set("etag methods", "GET"), TypeError);
    assert.throws(() => express().set("etag methods", [42]), TypeError);

    close();
});
