// a trailing slash is allowed by the pattern, not taken off the path
//
// Express compiles a route without strict routing so that it may end with one slash, and matches
// the path as it arrived. This project used to shorten the path instead, which cannot tell /x from
// /x/ afterwards: // reached no wildcard route, a request in another case with a trailing slash
// reached nothing at all, and an optional group at the end of a pattern chose the wrong route.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// a path of nothing but slashes is still a path, with empty segments in it
app.get("/w/*rest", (req, res) => res.json({ r: "w", rest: req.params.rest }));
app.get("/*any", (req, res) => res.json({ r: "any", any: req.params.any }));

// the same route asked for in another case and with a slash, which are two different reasons to
// miss a native registration and used to be one too many
app.get("/ASDF", (req, res) => res.send("upper"));
app.get("/lower", (req, res) => res.send("lower"));
app.get("/def/", (req, res) => res.send("written with a slash"));

// an optional group at the end, where the slash decides which route answers
app.get("/opt/:a/{:b}", (req, res) => res.json({ r: "opt", params: req.params }));
app.get("/opt/:only", (req, res) => res.json({ r: "only", params: req.params }));

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        "//",
        "///",
        "/",
        "/w//",
        "/w/a/",
        "/w/a//b",
        "//a",
        "/ASDF",
        "/ASDF/",
        "/asdf",
        "/asdf/",
        "/AsDf/",
        "/lower",
        "/lower/",
        "/LOWER",
        "/LOWER/",
        "/def",
        "/def/",
        "/DEF/",
        "/opt/x",
        "/opt/x/",
        "/opt/x/y",
        "/opt/x/y/"
    ];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
