// what a wildcard is allowed to swallow when another one is already in the path
//
// path-to-regexp holds the second wildcard of a path to a single segment, and one sharing a
// segment with an earlier wildcard stops at the text between them. Compiling both as "anything at
// all" let /*a/:b/*c answer /m/1/2/3/ under strict routing, where express refuses it, and that is
// the wrong direction to be wrong in: strict routing exists to tell /x from /x/.
// An optional wildcard needs the slash in front of it too, so /a/{*w} does not answer /a.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const strictApp = express();
strictApp.set("etag", false);
strictApp.set("strict routing", true);

const looseApp = express();
looseApp.set("etag", false);

for (const app of [strictApp, looseApp]) {
    app.get("/one/*p", (req, res) => res.json({ r: "one", p: req.params.p }));
    app.get("/two/*a/*b", (req, res) => res.json({ r: "two", params: req.params }));
    app.get("/mid/*a/:b/*c", (req, res) => res.json({ r: "mid", params: req.params }));
    // two wildcards inside one segment, separated by text they must not eat
    app.get("/dash/*a-*b", (req, res) => res.json({ r: "dash", params: req.params }));
    // a parameter after a wildcard in the same segment, which must stop at the dot
    app.get("/ext/*w.:ext", (req, res) => res.json({ r: "ext", params: req.params }));
    // the optional wildcard, at the root and below it
    app.get("/opt/{*w}", (req, res) => res.json({ r: "opt", params: req.params }));
    app.get("/{*root}", (req, res) => res.json({ r: "root", params: req.params }));
    app.use((req, res) => res.status(404).send("no route"));
}

// The optional wildcard is asked only under strict routing. Without it the path arrives here
// already shortened by its trailing slash, so /opt and /opt/ cannot be told apart, while express
// answers the second and refuses the first. That is the trailing slash difference this project
// still carries, and it belongs to the path and not to the pattern.
const strictOnly = ["/opt", "/opt/", "/opt/x", "/opt/x/y"];

const paths = [
    "/one/a",
    "/one/a/",
    "/one/a/b",
    "/one/a/b/",
    "/two/1/2",
    "/two/1/2/",
    "/two/1/2/3",
    "/two/1/2/3/",
    "/mid/1/2/3",
    "/mid/1/2/3/",
    "/mid/1/2/3/4",
    "/dash/x-y",
    "/dash/x-y-z",
    "/dash/a/b-c",
    "/ext/x.json",
    "/ext/x.tar.gz",
    "/ext/a/b.json",
    "/",
    "/anything",
    "/anything/else"
];

strictApp.listen(13333, () => {
    console.log("Server is running on port 13333");
    looseApp.listen(13334, async () => {
        for (const [label, port] of [
            ["strict", 13333],
            ["loose", 13334]
        ]) {
            for (const path of label === "strict" ? [...paths, ...strictOnly] : paths) {
                const res = await fetchTest(`http://localhost:${port}${path}`);
                console.log(label, path, res.status, await res.text());
            }
        }
        process.exit(0);
    });
});
