// what app.use() accepts and what it refuses, at registration and not at the first request
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// nested arrays of middleware, at any depth, all run in order
const fn1 = (req, res, next) => {
    res.setHeader("x-fn-1", "hit");
    next();
};
const fn2 = (req, res, next) => {
    res.setHeader("x-fn-2", "hit");
    next();
};
const fn3 = (req, res, next) => {
    res.setHeader("x-fn-3", "hit");
    next();
};
app.use([[fn1], fn2], [fn3]);

// a RegExp mount, which strips what it matched from the path like any other
app.use(/^\/[a-z]oo/, (req, res) => {
    res.send(`saw ${req.method} ${req.url} through ${req.originalUrl}`);
});

app.use((req, res) => res.status(404).send("no route"));

for (const [label, register] of [
    ["no handler", () => app.use("/")],
    ["string", () => app.use("/", "foo")],
    ["number", () => app.use("/", 42)],
    ["null", () => app.use("/", null)],
    ["date", () => app.use("/", new Date())],
    ["router with no handler", () => express.Router().use("/")]
]) {
    try {
        register();
        console.log(label, "no throw");
    } catch (err) {
        console.log(label, err.constructor.name, err.message);
    }
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/", "/foo", "/zoo/bear", "/get/zoo"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, res.headers.get("x-fn-1"), res.headers.get("x-fn-3"), await res.text());
    }

    process.exit(0);
});
