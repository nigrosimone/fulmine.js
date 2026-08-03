// a sendFile error reaches the callback with the response untouched, so the callback still
// answers 200; without a callback a directory falls through as a plain next()

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/missing", (req, res) => {
    res.sendFile("src/does-not-exist.js", { root: "." }, (err) => {
        res.send(err ? `got ${err.status} ${err.code}` : "no error");
    });
});

app.get("/dotfile", (req, res) => {
    res.sendFile(".gitignore", { root: "." }, (err) => {
        res.send(err ? `got ${err.status}` : "no error");
    });
});

app.get("/dir", (req, res) => {
    res.sendFile("src", { root: "." });
});

app.use((req, res) => {
    res.status(200).send("fell through");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const missing = await fetchTest("http://localhost:13333/missing");
    console.log(await missing.text());

    const dotfile = await fetchTest("http://localhost:13333/dotfile");
    console.log(await dotfile.text());

    const dir = await fetchTest("http://localhost:13333/dir");
    console.log(await dir.text());

    process.exit(0);
});
