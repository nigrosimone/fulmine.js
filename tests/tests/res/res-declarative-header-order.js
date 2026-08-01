// must apply the header calls in the order they run, and stop at the one that sends

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// Every handler here is simple enough to be compiled into a native response, which means the
// compiler reads the calls out of the source instead of running them. Two things about that are
// easy to get wrong, and both were: a chain is walked outermost first, so res.status(a).status(b)
// read backwards, and a call written after the response has been sent has no effect at all.
app.get("/append-then-set", (req, res) => {
    res.append("x-a", "1");
    res.append("x-a", "2");
    res.set("x-a", "3");
    res.send("k");
});
app.get("/append-twice", (req, res) => {
    res.append("x-a", "1");
    res.append("x-a", "2");
    res.send("k");
});
app.get("/set-twice", (req, res) => {
    res.set("x-a", "1");
    res.set("x-a", "2");
    res.send("k");
});
app.get("/status-twice", (req, res) => res.status(201).status(202).send("k"));
app.get("/status-after-send", (req, res) => {
    res.send("k");
    res.status(201);
});
app.get("/set-after-sendstatus", (req, res) => {
    res.sendStatus(404);
    res.set("x-a", "1");
});
app.get("/cookies", (req, res) => {
    res.append("set-cookie", "a=1; Path=/");
    res.append("set-cookie", "b=2; Path=/");
    res.send("k");
});
// setHeader is node's and charsets nothing, so the charset here comes from send
app.get("/setheader-content-type", (req, res) => {
    res.setHeader("content-type", "text/plain");
    res.send("k");
});
app.get("/header-alias", (req, res) => {
    res.header("x-a", "1");
    res.send("k");
});

const PATHS = [
    "/append-then-set",
    "/append-twice",
    "/set-twice",
    "/status-twice",
    "/status-after-send",
    "/set-after-sendstatus",
    "/cookies",
    "/setheader-content-type",
    "/header-alias"
];

app.listen(13333, async () => {
    for (const path of PATHS) {
        const response = await fetchTest("http://localhost:13333" + path);
        console.log(path, JSON.stringify(await response.text()), response.headers.get("x-a"));
    }
    process.exit(0);
});
