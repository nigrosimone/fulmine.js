// the shape of req.params: null prototype on matched routes, plain on a pathless middleware
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.use((req, res, next) => {
    res.set("x-mw-proto", String(Object.getPrototypeOf(req.params) === null));
    next();
});
app.get("/plain", (req, res) => {
    res.send(`route ${Object.getPrototypeOf(req.params) === null} ${typeof req.params.hasOwnProperty}`);
});
app.get("/with/:id", (req, res) => {
    res.send(`param ${Object.getPrototypeOf(req.params) === null} ${req.params.id}`);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/plain", "/with/7"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, res.headers.get("x-mw-proto"), await res.text());
    }

    process.exit(0);
});
