// what a "query parser" of the application's own returns is req.query, as it is

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

class Query {}
app.set("query parser", (query) => {
    if (query === "array") {
        return ["a", "b"];
    }
    return Object.assign(new Query(), { query });
});

app.get("/q", (req, res) => {
    res.json({
        array: Array.isArray(req.query),
        own: req.query instanceof Query,
        query: req.query
    });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/q?array", "/q?a=1"]) {
        const res = await fetchTest("http://localhost:13333" + path);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
