// a req.url rewrite inside a prefix mount: the rest of the routing sees the rejoined url, and the
// 404 page prints the pathname of originalUrl, which a rewrite never changes

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();

app.use("/found", (req, res, next) => {
    req.url = "/target?x=1";
    next();
});

app.get("/found/target", (req, res) => {
    res.json({ query: req.query, url: req.url, originalUrl: req.originalUrl });
});

app.use("/gone", (req, res, next) => {
    req.url = "/nowhere?x=2";
    next();
});

// the whole path consumed: express strips the first character of the assigned url and rejoins,
// so "/found" + "target" lands here
app.get("/foundtarget", (req, res) => {
    res.json({ mangled: true, query: req.query, url: req.url });
});

// a remainder under the mount: the rejoin is clean and routes to the mount's own path
app.use("/clean", (req, res, next) => {
    req.url = "/target?x=3";
    next();
});

app.get("/clean/target", (req, res) => {
    res.json({ clean: true, query: req.query, url: req.url, originalUrl: req.originalUrl });
});

app.listen(13763, async () => {
    console.log("Server is running on port 13763");

    const responses = await sequential([
        () => fetchTest("http://localhost:13763/found").then((res) => res.text()),
        () => fetchTest("http://localhost:13763/gone").then((res) => res.text()),
        () => fetchTest("http://localhost:13763/gone?a=b").then((res) => res.text()),
        () => fetchTest("http://localhost:13763/clean/sub").then((res) => res.text())
    ]);

    console.log(responses);

    process.exit(0);
});
