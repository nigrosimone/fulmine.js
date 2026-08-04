// strict routing is about the end of a path, and a mount has none: a mount path written with a
// trailing slash still matches with or without it

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.enable("strict routing");

app.use("/user/", (req, res, next) => {
    res.setHeader("x-middleware", "true");
    next();
});
app.get("/user/test/", (req, res) => res.send("with slash"));
app.get("/user/plain", (req, res) => res.send("no slash"));

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    // the routes themselves stay strict: /user/test without the slash is a 404
    for (const path of ["/user/test/", "/user/test", "/user/plain", "/user/plain/"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, res.headers.get("x-middleware"), await res.text());
    }

    process.exit(0);
});
