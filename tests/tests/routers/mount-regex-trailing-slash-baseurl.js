// req.baseUrl drops the trailing slash a RegExp mount consumed
//
// A registered path has its trailing slash taken off before it becomes a mount, so only a RegExp
// mount can consume one, and only against a path that carries a second slash where the mount ends.
// Express drops one slash off each mount before joining them, which is why the answer is not the
// piece of the path the mounts took: below two of them it is "/a/b" and the path reads "/a//b".

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const show = (req, res) => res.json({ baseUrl: req.baseUrl, url: req.url, path: req.path });

const inner = express.Router();
inner.get("/*rest", show);
inner.get("/", show);

const outer = express.Router();
outer.use("/b", inner);
outer.get("/*rest", show);
app.use(/^\/a\//, outer);

// a mounted application rather than a router, which swaps req.app on the way in
const sub = express();
sub.set("etag", false);
sub.get("/*rest", show);
app.use(/^\/c\//, sub);

// and one whose pattern ends without a slash, which consumes none
const plain = express.Router();
plain.get("/*rest", show);
app.use(/^\/d/, plain);

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/a//b/x", "/a//b/", "/a//x", "/c//x", "/d/x", "/d//x", "/a/x"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
