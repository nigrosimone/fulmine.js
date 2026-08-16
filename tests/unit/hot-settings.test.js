// The settings the hot path reads are resolved once into Router#_hotSettings and kept until the
// epoch moves. What this pins is the invalidation: a set() after requests were served, and a mount
// that changes what a child resolves through its parent, must both reach the next request.

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

test("a set() after a request was served reaches the next response", async () => {
    let app;
    const { url, close } = await serve((a) => {
        app = a;
        a.get("/", (req, res) => res.send("x"));
    });

    // first request resolves the hot settings with x-powered-by off
    let res = await fetch(url);
    assert.strictEqual(res.headers.get("x-powered-by"), null);

    app.set("x-powered-by", true);
    res = await fetch(url);
    assert.strictEqual(res.headers.get("x-powered-by"), "Fulmine");

    close();
});

test("a query parser switched after a request was served parses the next one", async () => {
    let app;
    const { url, close } = await serve((a) => {
        app = a;
        a.get("/", (req, res) => res.json(req.query));
    });

    // the default simple parser keeps the bracket in the key
    let body = await (await fetch(`${url}/?a[b]=1`)).json();
    assert.deepStrictEqual(body, { "a[b]": "1" });

    app.set("query parser", "extended");
    body = await (await fetch(`${url}/?a[b]=1`)).json();
    assert.deepStrictEqual(body, { a: { b: "1" } });

    close();
});

test("a setting written straight into app.settings reaches the next response", async () => {
    let app;
    const { url, close } = await serve((a) => {
        app = a;
        a.enable("x-powered-by");
        a.get("/", (req, res) => res.send("x"));
    });

    let res = await fetch(url);
    assert.strictEqual(res.headers.get("x-powered-by"), "Fulmine");

    // express allows this and set() never sees it, so the kept copy used to answer the old value
    // until some unrelated set() happened to move the epoch and the change landed by surprise
    app.settings["x-powered-by"] = false;
    res = await fetch(url);
    assert.strictEqual(res.headers.get("x-powered-by"), null, "the direct write must take effect at once");

    app.settings["x-powered-by"] = true;
    res = await fetch(url);
    assert.strictEqual(res.headers.get("x-powered-by"), "Fulmine", "and so must the one putting it back");

    close();
});

test("deleting a setting straight out of app.settings reaches the next read too", () => {
    const app = express();
    app.set("json escape", true);
    assert.strictEqual(app._hot().jsonEscape, true);

    delete app.settings["json escape"];
    assert.strictEqual(app._hot().jsonEscape, undefined, "a delete must move the epoch as a set() does");
});

test("app.settings still reads and enumerates as a plain object", () => {
    const app = express();
    app.set("view engine", "html");

    // it is a Proxy now, and everything an application does with it has to be unchanged
    assert.strictEqual(app.settings["view engine"], "html");
    assert.strictEqual(app.get("view engine"), "html");
    assert.ok(Object.keys(app.settings).includes("view engine"));
    assert.ok("view engine" in app.settings);
    assert.strictEqual(JSON.parse(JSON.stringify(app.settings))["view engine"], "html");
    // what the app hands to a template, which express exposes as settings
    assert.strictEqual(app.locals.settings["view engine"], "html");
});

test("a mount refreshes what the child resolves through its parent", () => {
    const parent = express();
    const child = express.Router();

    // resolved before the mount, when there is no parent to read through
    assert.strictEqual(child._hot().jsonEscape, undefined);

    parent.set("json escape", true);
    parent.use(child);
    assert.strictEqual(child._hot().jsonEscape, true);

    // and a parent set() after the mount reaches the child's kept copy too
    parent.set("json escape", false);
    assert.strictEqual(child._hot().jsonEscape, false);
});
