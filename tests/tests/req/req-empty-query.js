// a lone "?" belongs to req.url, and tells "/a?" from "/a"
// INSPECT
//
// uWS reports no query string as undefined and an empty one as "", which is the distinction
// express keeps in req.url and req.originalUrl. Collapsing them was invisible in routing and in
// req.query, which is why only a fuzz against express noticed it.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const report = (req, res) => {
    res.json({
        url: req.url,
        originalUrl: req.originalUrl,
        path: req.path,
        query: req.query,
        keys: Object.keys(req.query).length
    });
};

app.get("/plain", report);
app.get("/param/:id", report);

// a rewrite has to keep the "?" it was handed, and lose the one it was not
app.get("/rewrite", (req, res, next) => {
    req.url = "/target?";
    next();
});
app.get("/rewrite-clean", (req, res, next) => {
    req.url = "/target";
    next();
});
app.get("/target", report);

const mounted = express.Router();
mounted.get("/inner", report);
app.use("/mnt", mounted);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        "/plain",
        "/plain?",
        "/plain?x=1",
        "/plain?=",
        "/plain?&",
        "/param/7",
        "/param/7?",
        "/mnt/inner",
        "/mnt/inner?",
        "/rewrite",
        "/rewrite?keep=me",
        "/rewrite-clean?",
        "/absent",
        "/absent?"
    ];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
