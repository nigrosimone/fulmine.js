// express.static serves an index whose name starts with a dot, send checks dotfiles only on the path asked for

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fetchTest } = require("../../helpers.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-dot-index-"));
fs.writeFileSync(path.join(root, ".home.html"), "home");
fs.mkdirSync(path.join(root, "sub"));
fs.writeFileSync(path.join(root, "sub", ".home.html"), "sub home");
// each arm writes its own files: one mtime, so the ETags compare
const mtime = new Date("2026-01-01T00:00:00Z");
fs.utimesSync(path.join(root, ".home.html"), mtime, mtime);
fs.utimesSync(path.join(root, "sub", ".home.html"), mtime, mtime);

const app = express();
for (const dotfiles of ["ignore", "deny", "allow"]) {
    app.use("/" + dotfiles, express.static(root, { index: ".home.html", dotfiles }));
}
app.use((req, res) => res.status(404).send("404"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const dotfiles of ["ignore", "deny", "allow"]) {
        // the index added to a directory, and the same file asked for by its name
        for (const rest of ["/", "/sub/", "/.home.html", "/sub/.home.html"]) {
            const res = await fetchTest("http://localhost:13333/" + dotfiles + rest);
            console.log(dotfiles + rest, res.status, await res.text());
        }
    }

    fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
});
