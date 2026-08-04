// two param routes whose shapes overlap: express runs them in registration order, whatever the
// INSPECT
// router underneath prefers, and each handler sees its own parameter names

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// same shape, different names, a middleware in between
app.get("/a/:x", (req, res, next) => {
    res.set("x-first", JSON.stringify(req.params));
    next();
});
app.use((req, res, next) => next());
app.get("/a/:y", (req, res) => {
    res.set("x-second", JSON.stringify(req.params));
    res.send("done");
});

// the same path twice: both run, in order
app.get("/twice/:id", (req, res, next) => {
    res.set("x-one", req.params.id);
    next();
});
app.get("/twice/:id", (req, res) => {
    res.send(`two ${req.params.id}`);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/a/hello", "/twice/42"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(
            path,
            res.status,
            res.headers.get("x-first"),
            res.headers.get("x-second"),
            res.headers.get("x-one"),
            await res.text()
        );
    }

    process.exit(0);
});
