// must send the same body and ETag for empty responses and sendStatus

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// all four compile to a declarative response, which is the path these got wrong: an empty send
// answered "OK", and every sendStatus shared the ETag of an empty body, so a cache could not tell
// a 404 from a 500
app.get("/empty-send", (req, res) => res.send());
app.get("/empty-end", (req, res) => res.end());
app.get("/status-404", (req, res) => res.sendStatus(404));
app.get("/status-500", (req, res) => res.sendStatus(500));

app.listen(13333, async () => {
    for (const path of ["/empty-send", "/empty-end", "/status-404", "/status-500"]) {
        const response = await fetchTest("http://localhost:13333" + path);
        const body = await response.text();
        console.log(path, response.status, JSON.stringify(body), "etag=" + response.headers.get("etag"));
    }
    process.exit(0);
});
