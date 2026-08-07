// must support on-headers
// INSPECT
//
// The hook compression, morgan and express-session all reach for: it replaces res.writeHead so a
// listener runs at the moment the head goes out and can still change it. Worth its own test because
// it patches the response rather than using it, which is where a response that is not node's can
// differ, and because the demo now depends on it.

const express = require("express");
const onHeaders = require("on-headers");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.get("/adds", (req, res) => {
    onHeaders(res, function () {
        // `this` is the response, which is what the hook promises
        this.setHeader("x-added-late", "yes");
    });
    res.send("body");
});

// the hook runs after everything the handler set, so it sees and can replace what is there
app.get("/replaces", (req, res) => {
    onHeaders(res, () => {
        res.setHeader("x-decided", "by the hook");
        res.removeHeader("x-temporary");
    });
    res.setHeader("x-temporary", "gone");
    res.setHeader("x-decided", "by the handler");
    res.send("body");
});

// registered twice, and on-headers runs them last registered first
app.get("/order", (req, res) => {
    onHeaders(res, () => res.setHeader("x-order", (res.getHeader("x-order") || "") + "first"));
    onHeaders(res, () => res.setHeader("x-order", (res.getHeader("x-order") || "") + "second"));
    res.send("body");
});

// the status can be changed from inside the hook, which is what makes it a head hook rather than a
// header hook
app.get("/status", (req, res) => {
    onHeaders(res, () => {
        res.statusCode = 203;
    });
    res.status(200).send("body");
});

// and on a response that sends no body of its own
app.get("/empty", (req, res) => {
    onHeaders(res, () => res.setHeader("x-on-empty", "yes"));
    res.status(204).end();
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/adds", "/replaces", "/order", "/status", "/empty"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
