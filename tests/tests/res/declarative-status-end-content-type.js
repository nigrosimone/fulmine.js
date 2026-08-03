// res.status(n).end() sends no Content-Type; sendStatus() types its body text/plain, 200 included

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/statusend", (req, res) => res.status(404).end());
app.get("/statussend", (req, res) => res.status(404).send());
app.get("/ss404", (req, res) => res.sendStatus(404));
app.get("/ss200", (req, res) => res.sendStatus(200));

app.listen(13333, async () => {
    for (const path of ["/statusend", "/statussend", "/ss404", "/ss200"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, JSON.stringify(await res.text()));
    }
    process.exit(0);
});
