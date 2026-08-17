// must answer res.json and return res.send the same way whichever path serves them

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// etag off, or none of this is compiled: a response that would carry a validator is refused
app.set("etag", false);

// res.json and a returned res.send are two of the most common handler shapes there are, and both
// used to fall back to ordinary routing: json was not a method the compiler read, and the word
// "return" anywhere in the source stopped it. Everything here is compiled, so this compares the
// compiled answer against Express's.
app.get("/json-object", (req, res) => res.json({ a: 1, b: "x", c: true, d: null }));
app.get("/json-nested", (req, res) => res.json({ a: { b: [1, 2, { c: "d" }] }, e: -3 }));
app.get("/json-array", (req, res) => res.json([1, "two", false, null]));
app.get("/json-string", (req, res) => res.json("hello"));
app.get("/json-number", (req, res) => res.json(42));
app.get("/json-empty-object", (req, res) => res.json({}));
app.get("/json-quotes", (req, res) => res.json({ a: 'single "double" mix' }));
app.get("/json-status", (req, res) => res.status(201).json({ created: true }));
app.get("/json-typed", (req, res) => {
    res.set("content-type", "application/vnd.api+json");
    res.json({ a: 1 });
});

app.get("/return-send", (req, res) => {
    return res.send("hi");
});
app.get("/return-json", (req, res) => {
    return res.status(404).json({ error: "not found" });
});
app.get("/return-after-set", (req, res) => {
    res.set("x-a", "b");
    return res.send("hi");
});
app.get("/return-named", function (req, res) {
    return res.send("hi");
});
// a string that happens to read like a keyword, which used to be enough to stop the compiler
app.get("/return-word", (req, res) => {
    return res.send("return");
});

// These cannot be answered by a response written once, and have to reach the ordinary path. If one
// of them ever compiles, the answer below stops matching Express rather than quietly going wrong.
app.get("/falls-back-sequence", (req, res) => {
    return (res.append("x-m", "1"), res.send("k"));
});
app.get("/falls-back-conditional", (req, res) => res.send(req.query.a ? "yes" : "no"));
app.get("/falls-back-logical", (req, res) => res.send(req.query.a || "fallback"));
app.get("/falls-back-unreachable", (req, res) => {
    return res.send("first");
    res.set("x-a", "b"); // eslint-disable-line no-unreachable
});

const PATHS = [
    "/json-object",
    "/json-nested",
    "/json-array",
    "/json-string",
    "/json-number",
    "/json-empty-object",
    "/json-quotes",
    "/json-status",
    "/json-typed",
    "/return-send",
    "/return-json",
    "/return-after-set",
    "/return-named",
    "/return-word",
    "/falls-back-sequence",
    "/falls-back-conditional",
    "/falls-back-logical",
    "/falls-back-unreachable"
];

app.listen(13333, async () => {
    // pins the compiled path: express has no testing namespace, so this runs on our side only.
    // The falls-back ones are the other half of the comparison and are left out on purpose
    if (express.testing) express.testing.expectDeclarative(app, ["/json-*", "/return-*"]);

    for (const path of PATHS) {
        const response = await fetchTest("http://localhost:13333" + path);
        console.log(
            path,
            JSON.stringify(await response.text()),
            response.headers.get("x-a"),
            response.headers.get("x-m")
        );
    }
    process.exit(0);
});
