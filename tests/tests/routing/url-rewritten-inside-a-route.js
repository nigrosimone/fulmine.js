// req.path follows a req.url one callback of a route assigned, before the next one runs
//
// Express reads req.path off req.url on every access, so what runs after the rewrite sees the new
// path even inside the same route. The router here takes a rewrite over at its next hop, which
// comes after the route, so req.path stayed one hop behind: a middleware collapsing the leading
// slashes of "//" left req.path at "//" where express reports "/".
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const echo = (req, res) =>
    res.json({ url: req.url, originalUrl: req.originalUrl, path: req.path, baseUrl: req.baseUrl });

app.all(
    "/{:o19}",
    (req, res, next) => {
        req.url = req.url.replace(/^\/+/, "/");
        next();
    },
    echo
);

// and inside a mount, where what is assigned is relative to the mount
const mounted = express.Router();
mounted.get(
    "/deep/*rest",
    (req, res, next) => {
        req.url = "/other?q=1";
        next();
    },
    echo
);
app.use("/m", mounted);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["//", "/", "/x", "///", "/m/deep/a/b"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
