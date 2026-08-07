// what express.static answers when it will not serve the file, and what it names
//
// Three things the fuzzer caught here, all of them about order. send judges a path before it looks
// at the disk, so a hidden segment anywhere in a path that does not exist answers the dotfiles rule
// rather than the disk's ENOENT. It reports the last candidate it tried, so an extensions option
// that also missed names the file it looked for. And it does not try an extension on a path written
// with a trailing slash, since that names a directory. Turning the etag off applies to the file and
// not to whatever an error handler sends afterwards.

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fetchTest } = require("../../helpers.js");

// written once and left in place, so the two arms read one modification time and one ETag
const dir = path.join(os.tmpdir(), "fulmine-static-error-shapes");
if (!fs.existsSync(path.join(dir, "a.txt"))) {
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.txt"), "the quick brown fox jumps over the lazy dog");
    fs.writeFileSync(path.join(dir, "x.html"), "<!doctype html><title>x</title>");
    fs.writeFileSync(path.join(dir, "sub", "deep.txt"), "deep");
}

const app = express();

app.use("/ext", express.static(dir, { extensions: ["html"], fallthrough: false }));
app.use("/etagless", express.static(dir, { etag: false, fallthrough: false }));
app.use("/deny", express.static(dir, { dotfiles: "deny", fallthrough: false }));
app.use("/ignore", express.static(dir, { dotfiles: "ignore", fallthrough: false }));

app.use((req, res) => res.status(404).send("no route"));
app.use((err, req, res, next) => res.status(err.status || 500).send("error: " + err.message));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const cases = [
        // the extension is tried, and named when it misses too
        ["/ext/x", {}],
        ["/ext/missing", {}],
        // and not tried at all when the path names a directory
        ["/ext/missing/", {}],
        ["/ext/sub/deep", {}],
        // the etag belongs to the file, and its absence does not follow the request around
        ["/etagless/a.txt", {}],
        ["/etagless/a.txt", { range: "bytes=900-999" }],
        ["/etagless/a.txt", { range: "bytes=x-y" }],
        ["/etagless/a.txt", { range: "bytes=0-4" }],
        // a hidden segment in the middle of a path that does not exist
        ["/deny/a/.hidden/b", {}],
        ["/ignore/a/.hidden/b", {}],
        ["/ignore/.hidden", {}],
        // and a path that walks up and comes back, which is not a hidden file
        ["/ignore/sub/../a.txt", {}],
        // a decoded NUL is a bad request: letting it reach fs answered with node own complaint,
        // which carries the absolute path of the root inside it
        ["/ignore/a%00b", {}],
        ["/ext/a%00b/c", {}],
        // an encoded slash is not a trailing slash: the path names a file called "/" inside a
        // directory, so no index is looked for and no extension is tried. Only the one that
        // resolves to something real is asked here: where nothing is there, the name inside the
        // ENOENT differs by platform, because send stats what normalize left and this stats what
        // resolve left, and resolve is the one that drops a trailing separator. The status and the
        // error are the same either way, and chasing the two spellings once cost a red main.
        ["/ignore/sub/%2F", {}]
    ];

    for (const [url, headers] of cases) {
        const res = await fetchTest(`http://localhost:13333${url}`, { headers });
        console.log(url, JSON.stringify(headers), res.status, (await res.text()).replace(dir, "<dir>"));
    }

    process.exit(0);
});
