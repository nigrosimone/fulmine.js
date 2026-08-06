// a request with a trailing slash goes to the first route that answers it, native or not
//
// Without strict routing a route answers both spellings of its path, so an earlier pattern that
// matches only the slashed one still comes first. Deciding whether a later literal could be
// registered natively by testing the path as written missed exactly that, and µWS then answered
// the literal for a request express gives to the route above it.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// the parameter route matches "/x/" as two segments, the second empty, and comes first
app.get("/:one/{:two}", (req, res) => res.type("txt").send("param route"));
app.get("/a@@b~.~c", (req, res) => res.type("txt").send("literal route"));

// the same shape with an ordinary word, and with the two registered the other way round
app.get("/:only/{:opt}", (req, res) => res.type("txt").send("param first"));
app.get("/plain", (req, res) => res.type("txt").send("literal second"));
app.get("/other", (req, res) => res.type("txt").send("literal first"));
app.get("/:late/{:opt2}", (req, res) => res.type("txt").send("param late"));

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        "/a@@b~.~c",
        "/a@@b~.~c/",
        "/plain",
        "/plain/",
        "/other",
        "/other/",
        "/anything",
        "/anything/",
        "/two/segments"
    ];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
