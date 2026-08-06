// how a segment is divided when more than one capture shares it
//
// path-to-regexp gives a parameter the whole segment only when it is alone in it. Beside another
// parameter it may also be exactly the text that separates them; before a wildcard in the same
// segment both give ground, so the wildcard has something left to match. Compiling every parameter
// as "up to the next slash" divided /a-b-c between /:foo-:bar-*baz differently from express.
// Found by fuzzing route tables against express, with the patterns taken from path-to-regexp's own
// test corpus.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.get("/two/:a-:b", (req, res) => res.json(req.params));
app.get("/three/:a-:b-:c", (req, res) => res.json(req.params));
app.get("/dot/:a.:b", (req, res) => res.json(req.params));
app.get("/file/:name.:ext", (req, res) => res.json(req.params));
app.get("/before/:foo-:bar-*baz", (req, res) => res.json(req.params));
app.get("/after/*w-:x", (req, res) => res.json(req.params));
app.get("/ext/*w.:e", (req, res) => res.json(req.params));
app.get("/opt/:file{.:ext}", (req, res) => res.json(req.params));

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        "/two/a-b",
        "/two/a-b-c",
        "/two/a-",
        "/two/-b",
        "/two/-",
        "/three/a-b-c",
        "/three/a-b-c-d",
        "/three/a---d",
        "/dot/a.b",
        "/dot/a.b.c",
        "/file/x.json",
        "/file/x.tar.gz",
        "/before/a-b-c",
        "/before/a-b-c-d",
        "/before/a-b-c/d",
        "/after/a-b",
        "/after/a/b-c",
        "/ext/a.json",
        "/ext/a/b.json",
        "/ext/a.b.json",
        "/opt/name",
        "/opt/name.json",
        "/opt/name.tar.gz"
    ];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
