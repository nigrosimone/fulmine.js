// sendStatus types its body text/plain over a type set before it, compiled or not (fuzz seed 721475712)

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
// without an ETag sendStatus is compiled into a declarative response
app.set("etag", false);
app.get("/type", (req, res) => {
    res.type("png");
    res.sendStatus(201);
});
app.get("/set", (req, res) => {
    res.set("Content-Type", "text/html");
    res.sendStatus(404);
});
app.get("/destructured", ({ query: { q } }, res) => {
    res.type("json");
    res.sendStatus(202);
});

app.listen(13333, async () => {
    await sequential(
        ["/type", "/set", "/destructured"].map((path) => async () => {
            const res = await fetchTest(`http://localhost:13333${path}`);
            console.log(path, res.status, JSON.stringify(await res.text()));
        })
    );
    process.exit(0);
});
