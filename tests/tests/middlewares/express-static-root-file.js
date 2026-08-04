// express.static() with a file as root serves it plain and 404s the trailing slash
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.use("/file.txt", express.static("tests/parts/small-file.json"));

app.use((req, res, next) => {
    res.status(404).send("404");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const plain = await fetchTest("http://localhost:13333/file.txt");
    console.log("plain", plain.status, await plain.text());

    const slash = await fetchTest("http://localhost:13333/file.txt/");
    console.log("slash", slash.status, await slash.text());

    process.exit(0);
});
