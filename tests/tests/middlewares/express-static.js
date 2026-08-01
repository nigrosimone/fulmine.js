// must support express.static()

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.post("/abc", (req, res) => {
    res.send("ok");
});
// collected rather than logged as it happens: the five requests below are concurrent, so a log
// written while one is being served lands between the lines the client prints for the others, and
// where exactly depends on which response comes back first
const caught = [];
app.use("/static", (req, res, next) => {
    express.static("src")(req, res, (e) => {
        caught.push(String(e));
        next();
    });
});

app.use("/static", express.static("tests/parts"));

app.use((req, res, next) => {
    res.status(404).send("404");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const responses = await Promise.all([
        fetchTest("http://localhost:13333/abc"),
        fetchTest("http://localhost:13333/static/workers"),
        fetchTest("http://localhost:13333/static/"),
        fetchTest("http://localhost:13333/static/index.js?1"),
        fetchTest("http://localhost:13333/static/../package.json")
    ]);

    const texts = await Promise.all(responses.map((r) => r.text()));

    console.log(texts.map((t) => t.slice(0, 30)));
    console.log("fell through:", caught.sort());

    process.exit(0);
});
