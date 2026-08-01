// must support optional groups with braces {:file{.:ext}}

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/files/:name{.:ext}", (req, res) => {
    res.json({ name: req.params.name, ext: req.params.ext || "none" });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const responses = await Promise.all([
        fetchTest("http://localhost:13333/files/readme.md").then((res) => res.text()),
        fetchTest("http://localhost:13333/files/readme").then((res) => res.text()),
        fetchTest("http://localhost:13333/files/archive.tar.gz").then((res) => res.text())
    ]);

    console.log(responses);
    process.exit(0);
});
