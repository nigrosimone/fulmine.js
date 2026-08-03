// a HEAD route before a GET route on the same path: GET must not run the HEAD handler

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.head("/health", (req, res) => {
    res.set("x-served-by", "head-handler");
    res.end();
});
app.get("/health", (req, res) => {
    res.set("x-served-by", "get-handler");
    res.send("full body");
});

// and the other order, where GET answers HEAD when no HEAD route matched first
app.get("/only-get", (req, res) => {
    res.set("x-served-by", "get-handler");
    res.send("body");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const [path, method] of [
        ["/health", "GET"],
        ["/health", "HEAD"],
        ["/only-get", "GET"],
        ["/only-get", "HEAD"]
    ]) {
        const res = await fetchTest(`http://localhost:13333${path}`, { method });
        console.log(method, path, res.status, res.headers.get("x-served-by"), JSON.stringify(await res.text()));
    }

    process.exit(0);
});
