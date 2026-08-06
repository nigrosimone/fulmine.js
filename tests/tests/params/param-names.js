// what may be written as a parameter name, and what happens when the same name is written twice
//
// path-to-regexp takes a javascript identifier, so /:café and /:año are ordinary routes. Reading
// the name with \w stopped at ASCII, and every route with an accent in a parameter name answered
// 404 instead. A name written twice is allowed too, and a capture group cannot be, so the second
// one is compiled under a spelling of its own and reported under the name that was written.
// Found by fuzzing route tables against express.
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.get("/u/:café", (req, res) => res.json(req.params));
app.get("/d/:año/:x", (req, res) => res.json(req.params));
app.get("/w/*café", (req, res) => res.json(req.params));
app.get("/j/:日本", (req, res) => res.json(req.params));
app.get("/s/:_under/:$dollar", (req, res) => res.json(req.params));

// the same name twice, where express reports the last one that matched
app.get("/twice/:a/:a", (req, res) => res.json(req.params));
app.get("/thrice/:a/:a/:a", (req, res) => res.json(req.params));
app.get("/splat/*s/*s", (req, res) => res.json(req.params));
app.get("/mixed/:a{/:a}", (req, res) => res.json(req.params));

app.use((req, res) => res.status(404).send("no route"));

// the spellings that are not names at all: both refuse them, with the same message
for (const bad of ["/:1a", "/:", "/*1a", "/:{x}"]) {
    try {
        express.Router().get(bad, (req, res) => res.end());
        console.log("registering", bad, "was accepted");
    } catch (err) {
        console.log("registering", bad, "threw:", err.message);
    }
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        "/u/x",
        "/u/é",
        "/d/1/2",
        "/w/a/b",
        "/j/tokyo",
        "/s/one/two",
        "/twice/x/y",
        "/thrice/x/y/z",
        "/splat/1/2/3",
        "/mixed/x",
        "/mixed/x/y"
    ];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
