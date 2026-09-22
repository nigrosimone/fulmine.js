// express.static tries its extensions only when the path does not exist, as send does
// ENOTDIR or ENAMETOOLONG must report the path asked, not the last extension (fuzz seed 3561875562)

const express = require("express");
const path = require("path");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const root = path.join(process.cwd(), "tests", "parts");
// longer than a file name may be
const LONG = "n".repeat(300);

app.use(express.static(root, { extensions: ["html", "json"], fallthrough: false }));
app.use((err, req, res, next) => {
    // the root is this machine's path, only what follows it tells which file was looked for
    const message = String(err.message).split(root).join("<root>").split(LONG).join("<long name>");
    res.status(500).json({ message, status: err.status, code: err.code });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        // through a file: ENOTDIR on the first stat, no extension tried
        "/small-file.json/inside",
        "/index.html/deeper/still",
        // ENAMETOOLONG, the same
        "/" + LONG,
        // missing: ENOENT, every extension tried and the last one reported
        "/nowhere",
        // found through an extension, and a file asked for by its own name
        "/index",
        "/small-file"
    ];
    for (const p of paths) {
        const res = await fetchTest("http://localhost:13333" + p);
        const text = await res.text();
        console.log(
            p.split(LONG).join("<long name>"),
            res.status,
            text.length > 200 ? "<" + text.length + " bytes>" : text
        );
    }

    process.exit(0);
});
