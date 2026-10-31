// A minifier renames classes (terser does by default, esbuild without --keep-names), so nothing in
// src may tell an application by its constructor's name. The rename is simulated here, in a file of
// its own because it changes the class for the whole process.

const test = require("node:test");
const assert = require("node:assert");

const express = require("../../src/index.js");
const { Application } = require("../../src/application.js");

Object.defineProperty(Application, "name", { value: "t" });

test("a sub-app is still req.app under a renamed class, mounted or called by hand", async () => {
    const app = express();
    const sub = express();
    const other = express();
    app.locals.who = "main";
    sub.locals.who = "sub";
    other.locals.who = "other";
    sub.get("/x", (req, res) => res.send(req.app.locals.who));
    other.get("/h", (req, res) => res.send(req.app.locals.who));
    app.use("/s", sub);
    app.get("/h", (req, res, next) => other.handle(req, res, next));

    await new Promise((resolve) => app.listen(0, () => resolve(undefined)));
    const port = app.address().port;
    try {
        assert.equal(await (await fetch(`http://localhost:${port}/s/x`)).text(), "sub");
        assert.equal(await (await fetch(`http://localhost:${port}/h`)).text(), "other");
    } finally {
        await new Promise((resolve) => app.close(() => resolve(undefined)));
    }
});

test("app.use() with nothing keeps express's message under a renamed class", () => {
    assert.throws(() => express().use(), { message: "app.use() requires a middleware function" });
});
