// must decide a file's ETag the way send decides it

const express = require("express");
const { fetchTest } = require("../../helpers.js");

// Three different rules meet here and none of them is the obvious one:
//   express.static  never asks the app, so a file keeps its ETag under app.set("etag", false)
//                   and only { etag: false } on the middleware turns it off
//   res.sendFile    takes the app's setting and overrides whatever the caller passed, so
//                   { etag: false } does nothing while the app has ETags on
//   both            compute it from the stat, so a custom "etag fn" and app.set("etag", "strong")
//                   reach res.send() and never reach a file
const SETTINGS = [
    ["default", () => {}],
    ["etag false", (app) => app.set("etag", false)],
    ["etag strong", (app) => app.set("etag", "strong")],
    ["etag fn", (app) => app.set("etag fn", () => '"custom"')]
];

const PATHS = ["/static/small-file.json", "/static-no-etag/small-file.json", "/file", "/file-no-etag", "/send"];

(async () => {
    let port = 13333;
    for (const [name, configure] of SETTINGS) {
        const app = express();
        configure(app);
        app.use("/static", express.static("tests/parts"));
        app.use("/static-no-etag", express.static("tests/parts", { etag: false }));
        app.get("/file", (req, res) => res.sendFile("small-file.json", { root: "tests/parts" }));
        app.get("/file-no-etag", (req, res) => res.sendFile("small-file.json", { root: "tests/parts", etag: false }));
        app.get("/send", (req, res) => res.send("body"));

        await new Promise((resolve) => app.listen(port, resolve));

        for (const path of PATHS) {
            const response = await fetchTest(`http://localhost:${port}${path}`);
            await response.text();
            console.log(name, path, response.headers.get("etag"));
        }
        port++;
    }
    process.exit(0);
})();
