// must write Keep-Alive only together with a Connection of its own, as node does
//
// node writes the two as a pair: a response that sets Connection itself gets neither of node's, so
// no Keep-Alive goes out beside it. Every server-sent event stream sets it, the MCP Streamable HTTP
// transport included, and those responses carried a Keep-Alive here that Express never sends.
//
// Both paths are checked because both seed the pair, the ordinary one per response and the compiler
// once per route.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// etag off, or nothing compiles: a response that would carry a validator is refused
app.set("etag", false);

app.get("/compiled", (req, res) => res.set("connection", "keep-alive").send("ok"));

// the same answer off the ordinary path: the joined body is something the compiler does not follow
app.get("/ordinary", (req, res) => {
    const body = ["o", "k"].join("");
    res.set("connection", "keep-alive").send(body);
});

// nothing set, so both headers are the server's own and both go out
app.get("/untouched", (req, res) => res.send("ok"));

// a response that writes its own Keep-Alive keeps that one, whatever the Connection beside it says
app.get("/both", (req, res) => {
    const body = ["o", "k"].join("");
    res.set("connection", "keep-alive").set("keep-alive", "timeout=30").send(body);
});

app.listen(13333, async () => {
    // pins the compiled path: without it /compiled and /ordinary would agree by both being
    // ordinary, which proves nothing about the compiler
    if (express.testing) express.testing.expectDeclarative(app, "/compiled");

    for (const path of ["/compiled", "/ordinary", "/untouched", "/both"]) {
        const response = await fetchTest(`http://localhost:13333${path}`);
        await response.text();
        const value = response.headers.get("keep-alive");
        // the value, except on the route that sets none: there it is the server's own idle timeout,
        // 10 seconds against node's 5, which is why fetchTest compares this header by presence only
        console.log(path, "keep-alive:", path === "/untouched" ? value !== null : JSON.stringify(value));
    }

    process.exit(0);
});
