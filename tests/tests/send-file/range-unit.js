// must answer a Range in a unit other than bytes with the whole file, as send does: it checks the
// header's text for "bytes=" before parsing, so "items=0-1" and "Bytes=0-1" are not range requests

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { fetchTest } = require("../../helpers.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-range-"));
const file = path.join(dir, "data.txt");
fs.writeFileSync(file, "0123456789abcdef");
// the same mtime in both runs, so the ETag the file gets is the same on either side
fs.utimesSync(file, new Date(0), new Date(0));

const app = express();
app.get("/file", (req, res) => res.sendFile(file));

app.listen(13333, async () => {
    for (const range of ["bytes=0-1", "items=0-1", "Bytes=0-1", "bytes =0-1", "bytes=-2", "bytes=1-1,3-3"]) {
        const response = await fetchTest("http://localhost:13333/file", { headers: { range } });
        console.log(
            JSON.stringify(range),
            response.status,
            JSON.stringify(await response.text()),
            "content-range:",
            response.headers.get("content-range")
        );
    }
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(0);
});
