// express.static looks for the index inside whatever a trailing slash asked for, and takes a list
//
// A trailing slash is a request for a directory, and send answers it by looking for the index
// inside it whether or not the path is one: a file asked for that way fails as a missing index
// under that file rather than as a plain 404. The names are tried in order, so the option is a
// list, and an array of them used to reach path.join and throw.

const express = require("express");
const path = require("path");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const root = path.join(process.cwd(), "tests", "parts");

/** @param {any} target */
const mount = (at, options) => {
    const one = express();
    one.set("etag", false);
    one.use(express.static(root, { fallthrough: false, ...options }));
    one.use((err, req, res, next) => {
        // the path inside the message is this machine's, and only what follows the root says
        // which file was looked for
        const message = String(err.message).split(root).join("<root>");
        res.status(500).json({ message, status: err.status, code: err.code });
    });
    app.use(at, one);
};

mount("/one", { index: "index.html" });
mount("/list", { index: ["missing.html", "index.html"] });
mount("/none", { index: ["missing.html", "absent.html"] });
mount("/off", { index: false });

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [];
    for (const at of ["/one", "/list", "/none", "/off"]) {
        // a directory, a file asked for as one, a file, and a path that is neither
        for (const rest of ["/", "/index.html/", "/index.html", "/nowhere/"]) {
            paths.push(at + rest);
        }
    }

    for (const p of paths) {
        const res = await fetchTest("http://localhost:13333" + p, { redirect: "manual" });
        const text = await res.text();
        console.log(p, res.status, text.length > 120 ? "<" + text.length + " bytes>" : text);
    }

    process.exit(0);
});
