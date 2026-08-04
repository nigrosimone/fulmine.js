// must support dotfiles
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const path = require("path");

const app = express();

app.get("/test", (req, res) => {
    res.sendFile(path.join(process.cwd(), "src/.src/index.js"), {
        dotfiles: "deny"
    });
});

app.use((err, req, res, next) => {
    res.status(500).send(err.message);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const response = await fetchTest("http://localhost:13333/test");
    console.log(await response.text(), response.headers.get("Content-Type"));
    process.exit(0);
});
