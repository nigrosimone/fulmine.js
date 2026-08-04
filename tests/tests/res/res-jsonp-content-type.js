// a JSONP callback makes the body script, whatever content type was asked for first
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/typed", (req, res) => {
    res.type("application/vnd.example+json");
    res.jsonp({ hello: "world" });
});

app.get("/plain", (req, res) => {
    res.jsonp({ hello: "world" });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/typed?callback=cb", "/typed", "/plain?callback=cb", "/plain"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.headers.get("x-content-type-options"), await res.text());
    }

    process.exit(0);
});
