// must not say a connection is being kept alive when it is closing

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// Answered on the ordinary path, since a declarative response is written once and cannot vary
// with the request. What it does instead is in the README, under Performance tips.
app.get("/plain", (req, res) => {
    res.send(["o", "k"].join(""));
});

// something on the way out setting the header itself, which is what a proxy passing an upstream
// response through does
app.get("/closes", (req, res) => {
    res.set("Connection", "close");
    res.send(["o", "k"].join(""));
});

app.listen(13333, async () => {
    // one connection asking to be kept alive and one asking to be closed, so the difference is
    // the request's and not the route's
    await fetchTest("http://localhost:13333/plain").then((r) => r.text());
    await fetchTest("http://localhost:13333/plain", { headers: { Connection: "close" } }).then((r) => r.text());
    await fetchTest("http://localhost:13333/closes").then((r) => r.text());

    process.exit(0);
});
