// must support serve static

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const serveStatic = require("serve-static");

const app = express();

app.post("/abc", (req, res) => {
    res.send("ok");
});
// counted rather than logged as it happens: the four requests below are concurrent, so a log
// written while one is being served lands between the lines the client prints for the others, and
// where exactly depends on which response comes back first. The count says the same thing and says
// it at a fixed point.
let caught = 0;
app.use("/static", (req, res, next) => {
    serveStatic("src")(req, res, () => {
        caught++;
        next();
    });
});

app.use((req, res, next) => {
    res.status(404).send("404");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const responses = await Promise.all([
        fetchTest("http://localhost:13333/abc"),
        fetchTest("http://localhost:13333/static/workers"),
        fetchTest("http://localhost:13333/static/index.js"),
        fetchTest("http://localhost:13333/static/../package.json")
    ]);

    const texts = await Promise.all(responses.map((r) => r.text()));

    console.log(texts);
    console.log("fell through:", caught);

    process.exit(0);
});
