// res.set("Content-Type", v) looks v up in the mime database, as express does: an extension
// becomes its media type with the charset the database gives it, and a value the database knows
// nothing about is stored as false, so send, json, jsonp and sendFile write their own type

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const values = ["txt", "png", ".html", "text/plain", "application/manifest+json", "no-cache", "weird", ""];
// a file whose own extension names a type, so a content-type that resolved to false shows the
// file's own where express writes it
const file = "package.json";

const app = express();
app.set("etag", false);
values.forEach((v, i) => {
    app.get(`/send/${i}`, (req, res) => {
        res.set("Content-Type", v);
        res.send("body");
    });
    app.get(`/end/${i}`, (req, res) => {
        res.set("Content-Type", v);
        res.end("body");
    });
    app.get(`/json/${i}`, (req, res) => {
        res.set("Content-Type", v);
        res.json({ a: 1 });
    });
    app.get(`/file/${i}`, (req, res) => {
        res.set("Content-Type", v);
        res.sendFile(file, { root: "." });
    });
    // what res.get reads back, which is the boolean express stores
    app.get(`/read/${i}`, (req, res) => {
        res.set("Content-Type", v);
        const seen = res.get("Content-Type");
        res.set("Content-Type", "text/plain");
        res.send(typeof seen + ":" + String(seen));
    });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(
        ["send", "end", "json", "file", "read"].flatMap((kind) =>
            values.map((v, i) => async () => {
                const res = await fetchTest(`http://localhost:13333/${kind}/${i}`);
                console.log(kind, JSON.stringify(v), await res.text());
            })
        )
    );
    process.exit(0);
});
