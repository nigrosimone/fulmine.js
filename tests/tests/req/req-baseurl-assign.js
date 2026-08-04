// assigning req.baseUrl reads back, and does not change what later routes match against
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get(
    "/direct",
    (req, res, next) => {
        req.baseUrl = "/api";
        next();
    },
    (req, res) => {
        res.send(`baseUrl=${req.baseUrl} url=${req.url} path=${req.path}`);
    }
);

// the assignment must not leak into the path the next route matches and extracts params from
app.get("/skip", (req, res, next) => {
    req.baseUrl = "/api";
    next("route");
});
app.get("/:name", (req, res) => {
    res.send(`name=${req.params.name} path=${req.path} baseUrl=${req.baseUrl}`);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    let res = await fetchTest("http://localhost:13333/direct");
    console.log(await res.text());

    res = await fetchTest("http://localhost:13333/skip");
    console.log(await res.text());

    process.exit(0);
});
