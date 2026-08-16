// the text between a parameter and the parameter inside the optional group after it
//
// path-to-regexp keeps the whole of that text out of the group's own parameter, so the two cannot
// both take it, and lets the parameter be exactly that text as well. Reading only its first
// character left the parameter unable to match its own text, so the group never matched at all:
// /:foo{abc:bar} answered /123abcabc with foo taking the segment whole, where express splits it
// into foo=123 and bar=abc.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const patterns = ["/:foo{abc:bar}", "/:file{.:ext}", "/:a{x:b}", "/{abc:bar}", "/*w{.:ext}", "/:a{-:b}"];
for (const [i, pattern] of patterns.entries()) {
    app.get(pattern, (req, res) => res.json({ route: i, params: req.params }));
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/123abcabc", "/1abc2abc3", "/a.b.c", "/a.b.", "/abcx", "/xyz", "/a-b-c", "/abc"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
