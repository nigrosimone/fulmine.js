// must leave the content-type alone when res.json cannot serialise the body: express serialises
// before it sets the type, so what the handler answers after the throw is not typed as JSON

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/bigint", (req, res) => {
    try {
        res.json({ n: 1n });
    } catch (e) {
        res.status(500).send("threw " + e.constructor.name);
    }
});
app.get("/circular", (req, res) => {
    const loop = {};
    loop.self = loop;
    try {
        res.json(loop);
    } catch (e) {
        res.status(500).send("threw " + e.constructor.name);
    }
});
app.get("/fine", (req, res) => res.json({ ok: true }));

app.listen(13333, async () => {
    for (const path of ["/bigint", "/circular", "/fine"]) {
        const response = await fetchTest("http://localhost:13333" + path);
        console.log(path, response.status, await response.text());
    }
    process.exit(0);
});
