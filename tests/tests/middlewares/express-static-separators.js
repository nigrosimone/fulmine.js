// express.static judges the path as send does: "\" splits only where the platform says, and a ".." out is a 403 before the disk

const express = require("express");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-separators-"));
// on posix names with a backslash in them, on windows a directory and a file inside
for (const [name, body] of [
    ["a\\.b", "backslash-dot"],
    ["c.txt", "c"],
    ["d\\.e/f.txt", "inside"]
]) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
}

const mounts = ["ft-ignore", "ft-deny", "ft-allow", "strict-ignore", "strict-deny", "strict-allow"];
const app = express();
for (const mount of mounts) {
    const [fallthrough, dotfiles] = mount.split("-");
    app.use("/" + mount, express.static(root, { dotfiles, fallthrough: fallthrough === "ft" }));
}
app.use((err, req, res, next) => res.status(err.status || 500).send(`error ${err.status} ${err.code || ""}`));
app.use((req, res) => res.status(404).send("final 404"));

// raw paths: fetch turns "\" into "/" and drops the ".."
function get(p) {
    return new Promise((resolve) => {
        http.get({ host: "localhost", port: 13333, path: p, agent: false }, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve(`${res.statusCode} ${body}`));
        });
    });
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    // a sibling whose name starts as the root's does, which a prefix check lets through
    const sibling = "/../" + path.basename(root) + "-x/c.txt";
    for (const mount of mounts) {
        for (const p of ["/a%5C.b", "/x%5C.y", "/a%5C..%5Cc.txt", "/d%5C.e/f.txt", "/%5C.b"]) {
            console.log(mount + p, await get("/" + mount + p));
        }
        console.log(mount + " sibling", await get("/" + mount + sibling));
    }

    fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
});
