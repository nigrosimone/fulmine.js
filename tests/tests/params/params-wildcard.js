// must support wildcard params

const express = require("express");

const app = express();
const router = express.Router();

router.get("/test/*splat", (req, res) => {
    res.send("router: " + JSON.stringify(req.params));
});

router.get("/*splat", (req, res) => {
    res.send("router2: " + JSON.stringify(req.params));
});

app.use("/router/:param", router);

app.get("/hi/*splat", (req, res) => {
    res.send("once: " + JSON.stringify(req.params));
});

app.get("/twice/*first/wow/*second", (req, res) => {
    res.send("twice: " + JSON.stringify(req.params));
});

app.get("/after/:name/*splat", (req, res) => {
    res.send("name: " + JSON.stringify(req.params));
});

app.get("/*splat", (req, res) => {
    res.send("none: " + JSON.stringify(req.params));
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const outputs = await Promise.all([
        fetch("http://localhost:13333/router/param/test/123").then((res) => res.text()),
        fetch("http://localhost:13333/router/param/test/123/456").then((res) => res.text()),
        fetch("http://localhost:13333/router/param/123/456/789").then((res) => res.text()),

        fetch("http://localhost:13333/hi/123").then((res) => res.text()),
        fetch("http://localhost:13333/hi/123/456").then((res) => res.text()),

        fetch("http://localhost:13333/twice/123/wow/456").then((res) => res.text()),
        fetch("http://localhost:13333/twice/123/wow/456/789").then((res) => res.text()),

        fetch("http://localhost:13333/after/name/123").then((res) => res.text()),
        fetch("http://localhost:13333/after/name/123/456").then((res) => res.text()),

        fetch("http://localhost:13333/123").then((res) => res.text()),
        fetch("http://localhost:13333/123/456").then((res) => res.text())
    ]);

    console.log(outputs.join("\n"));
    process.exit(0);
});
