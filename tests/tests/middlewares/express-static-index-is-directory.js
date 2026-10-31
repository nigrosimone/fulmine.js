// express.static with an index name that is a directory: send skips it, and when every name is
// one the answer is a plain 404, passed on under fallthrough: false and skipped under the default

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fetchTest } = require("../../helpers.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "static-index-dir-"));
fs.mkdirSync(path.join(root, "sub", "index.html"), { recursive: true });
fs.mkdirSync(path.join(root, "sub", "home.html"));

const app = express();
app.set("etag", false);

const mount = (at, options) => {
    const one = express();
    one.set("etag", false);
    one.use(express.static(root, options));
    one.use((req, res) => res.status(418).send("fell through"));
    one.use((err, req, res, next) => {
        res.status(500).json({ message: err.message, status: err.status, code: err.code });
    });
    app.use(at, one);
};

mount("/strict", { fallthrough: false });
mount("/strict-list", { fallthrough: false, index: ["index.html", "home.html"] });
mount("/default", {});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const at of ["/strict", "/strict-list", "/default"]) {
        const res = await fetchTest("http://localhost:13333" + at + "/sub/", { redirect: "manual" });
        console.log(at, res.status, await res.text());
    }

    fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
});
