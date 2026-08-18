// what a "query parser" of the application's own is handed
//
// Express reads it with parseurl and passes `query`, which is null when the url carries no "?" at
// all and the text after it otherwise, the empty string included. A parser written for express may
// well check for null before it reads the string, and it was handed "" for both.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.set("query parser", (query) => ({
    type: query === null ? "null" : typeof query,
    value: query,
    parsed: query ? Object.fromEntries(new URLSearchParams(query)) : {}
}));

app.get("/read", (req, res) => res.json(req.query));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const asked = ["/read", "/read?", "/read?=", "/read?a=1&a=2", "/read?%2F=%2F", "/read?bare"];
    const answers = await sequential(asked.map((url) => () => fetchTest("http://localhost:13333" + url)));

    for (const [i, res] of answers.entries()) {
        console.log(asked[i], await res.text());
    }

    process.exit(0);
});
