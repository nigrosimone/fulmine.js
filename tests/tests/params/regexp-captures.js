// a RegExp route puts its capture groups in req.params: named ones by name, the rest by position

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get(/^\/a\/([0-9]+)\/(view|edit)?$/, (req, res) => res.json(req.params));
app.get(new RegExp("^/b/(?<userId>[0-9]+)/(view|edit)?$"), (req, res) => res.json(req.params));

// a RegExp mount consumes what it matched, and its captures come first for the router inside it
const merged = express.Router({ mergeParams: true });
merged.get(/^\/(.*)\.(.*)/, (req, res) => res.json({ params: req.params, url: req.url, baseUrl: req.baseUrl }));
app.use(/^\/user\/id:(\d+)/, merged);

// and a mount only matches where its match starts the path and breaks on a separator
const seen = [];
app.use(/\/api.*/, (req, res, next) => {
    seen.push("a");
    next();
});
app.use(/api/, (req, res, next) => {
    seen.push("b");
    next();
});
app.use(/\/test/, (req, res, next) => {
    seen.push("c");
    next();
});
app.get("/test/api/1234", (req, res) => res.send(seen.join(",")));

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/a/10/edit", "/a/10/", "/b/10/edit", "/user/id:10/profile.json", "/test/api/1234"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
