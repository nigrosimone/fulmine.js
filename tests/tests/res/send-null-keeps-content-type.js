// res.send(null) is an empty body: express 5.3 adds the charset in the string case of its switch
// only, so a content-type the application set goes out as it was, and none is added without one
// (a fuzz divergence, seed 731106817)

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.get("/set", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.send(null);
});
app.get("/type", (req, res) => {
    res.type("json").send(null);
});
app.get("/charset", (req, res) => {
    res.set("Content-Type", "text/plain; charset=latin1");
    res.send(null);
});
app.get("/none", (req, res) => {
    res.send(null);
});
app.get("/string", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.send("");
});

app.listen(13333, async () => {
    await sequential(
        ["/set", "/type", "/charset", "/none", "/string"].map((path) => async () => {
            const res = await fetchTest(`http://localhost:13333${path}`);
            console.log(path, res.status, JSON.stringify(await res.text()));
        })
    );
    process.exit(0);
});
