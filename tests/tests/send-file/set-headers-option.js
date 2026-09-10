// must honour setHeaders in express.static and ignore it in res.sendFile, as express does: the
// option is serve-static's own, and res.sendFile does not take it

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { fetchTest } = require("../../helpers.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-set-headers-"));
const file = path.join(dir, "data.txt");
fs.writeFileSync(file, "0123456789abcdef");
// the same mtime in both runs, so the ETag the file gets is the same on either side
fs.utimesSync(file, new Date(0), new Date(0));

const setHeaders = (res, filePath, stat) => {
    res.setHeader("X-Size", String(stat.size));
    res.setHeader("X-Base", path.basename(filePath));
};

const app = express();
app.get("/direct", (req, res) => res.sendFile(file, { setHeaders }));
app.use("/static", express.static(dir, { setHeaders }));

app.listen(13333, async () => {
    for (const route of ["/direct", "/static/data.txt"]) {
        const response = await fetchTest("http://localhost:13333" + route);
        console.log(
            route,
            response.status,
            JSON.stringify(await response.text()),
            "x-size:",
            response.headers.get("x-size"),
            "x-base:",
            response.headers.get("x-base")
        );
    }
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
});
