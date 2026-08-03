// a wildcard route with no prefix answers the root as well, and captures it the same way

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// what expressjs/perf-wg's own test server registers, and the shape that found this: fulmine
// answered every path but "/" here, because stripping the trailing slash left nothing to match
app.get("*path", (req, res) => res.json({ params: req.params, url: req.url }));
app.use((req, res) => res.status(404).json({ nothing: req.url }));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/", "/anything", "/a/b", "/a/b/", "/?x=1"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
