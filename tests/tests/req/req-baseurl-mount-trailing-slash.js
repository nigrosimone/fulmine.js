// must let an optional mount take the slash that ends the path, as path-to-regexp does
//
// path-to-regexp ends a mount with `(?:\/$)?`, so /{:o} on "//" takes both slashes and req.baseUrl
// reads back as "/", not "". Found by the fuzzer, seed 3148501386. The other rows are the shapes
// around it that already agreed: the slash after a segment, a deeper path, a regexp mount.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

const echo = (req, res) => res.json({ baseUrl: req.baseUrl, url: req.url, path: req.path, params: req.params });

const nested = express.Router();
nested.use("/{:b}", echo);

app.use("/opt/{:o}", nested);
app.use("/{:o}", echo);
app.use(/^\/re\/?/, echo);

app.listen(13333, async () => {
    for (const path of ["//", "///", "//x", "/a/", "/a//", "/a//x", "/opt///", "/opt/a//", "/re//", "/"]) {
        const response = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, await response.text());
    }

    process.exit(0);
});
