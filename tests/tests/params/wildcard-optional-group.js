// must split a wildcard and the optional group after it the way express does
//
// `/*path{.:ext}` is two tokens that both want the end of the path. path-to-regexp writes them out
// as an alternation, the branch with the group first and the wildcard greedy in both, so the
// extension goes to ext and everything before it to path. A single greedy capture followed by an
// optional group never lets the group match at all, and a lazy one hands the trailing slash away.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.get("/*path{.:ext}", (req, res) => {
    res.json({ path: req.params.path, ext: req.params.ext ?? null });
});

app.get("/one/:file{.:ext}", (req, res) => {
    res.json({ file: req.params.file, ext: req.params.ext ?? null });
});

app.get("/two/*path{/:page}", (req, res) => {
    res.json({ path: req.params.path, page: req.params.page ?? null });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        "/a/b.txt",
        "/a/b",
        "/x.y.z",
        "/a.b/c",
        // the trailing slash belongs to the wildcard, so the last segment is the empty one
        "/a/b/",
        "/deep/name.tar.gz",
        "/one/a.b.c",
        "/two/a/b/3"
    ];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
