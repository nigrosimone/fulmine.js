// must set headers through writeHead the way node does, not the way res.set does
//
// writeHead is node's method and Express does not override it, so a content-type given to it keeps
// the value it was given: `res.set("content-type", "text/html")` appends a charset and
// `res.writeHead(200, { "content-type": "text/html" })` does not. Everything built on top of
// Express answers this way, @astrojs/node and @sveltejs/adapter-node both build a response and
// write it with writeHead, so the difference was on every page they rendered.
//
// The flat array is node's third shape: a list of name, value, name, value, and not a list of
// pairs. An odd number of entries is refused.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.get("/object", (req, res) => {
    res.writeHead(200, { "content-type": "text/html", "x-one": "1" });
    res.end("object");
});

app.get("/message-and-object", (req, res) => {
    res.writeHead(201, "Created", { "content-type": "application/json", "x-one": "1" });
    res.end("{}");
});

app.get("/array", (req, res) => {
    res.writeHead(200, ["content-type", "text/plain", "x-one", "1"]);
    res.end("array");
});

app.get("/message-and-array", (req, res) => {
    res.writeHead(202, "Accepted", ["content-type", "text/plain", "x-one", "1"]);
    res.end("message and array");
});

app.get("/odd-array", (req, res) => {
    try {
        res.writeHead(200, ["content-type"]);
        res.end("no throw");
    } catch (err) {
        res.end(`threw ${err.code}`);
    }
});

// what was set before it is kept, and what writeHead names again wins
app.get("/merges", (req, res) => {
    res.setHeader("x-one", "before");
    res.setHeader("x-two", "kept");
    res.writeHead(200, { "x-one": "after" });
    res.end("merges");
});

// a repeated header, which node keeps as a list
app.get("/list", (req, res) => {
    res.writeHead(200, { "x-one": ["a", "b"] });
    res.end("list");
});

// no headers at all, which is the shape that only sets the status
app.get("/status-only", (req, res) => {
    res.writeHead(204);
    res.end();
});

app.use((err, req, res, next) => {
    res.status(500).end(`error ${err.code ?? err.message}`);
});

app.listen(13333, async () => {
    const paths = [
        "/object",
        "/message-and-object",
        "/array",
        "/message-and-array",
        "/odd-array",
        "/merges",
        "/list",
        "/status-only"
    ];

    const responses = await sequential(paths.map((path) => () => fetchTest(`http://localhost:13333${path}`)));

    for (let i = 0; i < responses.length; i++) {
        console.log(paths[i], [
            responses[i].status,
            await responses[i].text(),
            responses[i].headers.get("content-type"),
            responses[i].headers.get("x-one"),
            responses[i].headers.get("x-two")
        ]);
    }

    process.exit(0);
});
