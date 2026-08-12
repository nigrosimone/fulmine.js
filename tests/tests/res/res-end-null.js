// must answer res.end(null) the way it answers res.end()
//
// uWS given a null body writes a response the client never sees the end of, so this hung until
// _finish started handing it the empty string instead. Node and Express both send an empty 200.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.get("/null", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end(null);
});

app.get("/undefined", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end(undefined);
});

app.get("/empty", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end("");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/null", "/undefined", "/empty"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, JSON.stringify(await res.text()));
    }

    process.exit(0);
});
