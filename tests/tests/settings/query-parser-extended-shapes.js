// the extended parser answers what qs answers, including the shapes the shortcut used to guess at
//
// The extended parser sends short queries with no bracket and no dot to a faster parser, which is
// only sound where the two agree. They disagree on two shapes: an empty name, which fast parsing
// keeps as a pair and qs drops, and "__proto__", which qs never lets through. Both go the slow way
// now. The same function parses an extended urlencoded body, so that is checked here too.
// Found by fuzzing query strings against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);
app.set("query parser", "extended");

app.get("/q", (req, res) => res.json(req.query));
app.post("/b", express.urlencoded({ extended: true }), (req, res) => res.json(req.body));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const shapes = [
        "",
        "=",
        "=v",
        "a=1&=2",
        "==",
        "&=1",
        "a=1",
        "a=1&a=2",
        "a[]=1&a[]=2",
        "a[b][c]=1",
        // the names that live on Object.prototype: express asks qs to keep them, and req.query has
        // no prototype for them to reach
        "constructor=1",
        "toString=1",
        "valueOf[x]=1",
        "hasOwnProperty=2",
        "a[constructor]=1",
        // except this one, which qs drops whatever it is asked
        "__proto__=1",
        "__proto__[z]=1",
        "a[__proto__][z]=1"
    ];

    for (const shape of shapes) {
        const query = await fetchTest(`http://localhost:13333/q?${shape}`);
        console.log("query", JSON.stringify(shape), query.status, await query.text());

        const body = await fetchTest("http://localhost:13333/b", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: shape
        });
        console.log("body ", JSON.stringify(shape), body.status, await body.text());
    }

    process.exit(0);
});
