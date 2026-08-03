// must leave the caller's options object alone: two express.static mounts sharing one options
// object each keep their own root, as serve-static's copy of the options guarantees

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fetchTest } = require("../../helpers.js");

const app = express();

// fixture files of its own, with a pinned mtime so the ETag and Last-Modified the helper prints
// come out the same no matter when the two runs happen
const FIXED_TIME = new Date("2020-01-01T00:00:00Z");
const base = fs.mkdtempSync(path.join(os.tmpdir(), "ue-static-shared-"));
const dirA = path.join(base, "a");
const dirB = path.join(base, "b");
fs.mkdirSync(dirA);
fs.mkdirSync(dirB);
for (const [dir, content] of [
    [dirA, "FROM-A"],
    [dirB, "FROM-B"]
]) {
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, content);
    fs.utimesSync(file, FIXED_TIME, FIXED_TIME);
}

const sharedOptions = { redirect: false };
app.use("/a", express.static(dirA, sharedOptions));
app.use("/b", express.static(dirB, sharedOptions));

app.use((req, res) => res.status(404).send("app-404"));

app.listen(13333, async () => {
    for (const route of ["/a/f.txt", "/b/f.txt", "/a/f.txt"]) {
        const response = await fetchTest("http://localhost:13333" + route);
        console.log(route, response.status, await response.text());
    }

    // and the object handed in reads back as it was written
    console.log("caller options:", JSON.stringify(sharedOptions));

    process.exit(0);
});
