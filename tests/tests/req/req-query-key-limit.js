// the simple query parser reads 1000 pairs, as node's querystring, and drops the rest

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.get("/q", (req, res) => {
    res.json({ keys: Object.keys(req.query).length, x: req.query.x, last: req.query.last ?? null });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const queries = {
        under: "x&".repeat(998) + "last=1",
        at: "x&".repeat(999) + "last=1",
        over: "x&".repeat(1000) + "last=1",
        empty: "&".repeat(1000) + "last=1"
    };
    for (const [name, query] of Object.entries(queries)) {
        const res = await fetchTest("http://localhost:13333/q?" + query);
        const body = await res.json();
        console.log(name, res.status, body.keys, Array.isArray(body.x) ? body.x.length : body.x, body.last);
    }

    process.exit(0);
});
