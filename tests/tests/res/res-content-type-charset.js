// must charset a content-type the way set and send charset it

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// Two different rules, and both of them bite:
//   res.set   adds the charset the media type implies, for every type the mime database gives one
//             and not only for text/*
//   res.send  replaces it with utf-8 when the body is a string, because the body goes out as utf-8
//             whatever the header claimed
const TYPES = [
    "application/json",
    "application/ld+json",
    "application/manifest+json",
    "application/xml",
    "image/svg+xml",
    "application/javascript",
    "text/csv",
    "application/x-www-form-urlencoded",
    "text/html; charset=iso-8859-1",
    "application/octet-stream"
];

// end() is node's and touches neither rule, so it shows what set() alone decided
TYPES.forEach((type, i) => {
    app.get(`/set${i}`, (req, res) => {
        res.set("content-type", type);
        res.end("x");
    });
    app.get(`/send${i}`, (req, res) => {
        res.set("content-type", type);
        res.send("x");
    });
});

// The same again with a literal argument, so the handler is simple enough to be compiled into a
// declarative response and the compiled path is compared too. A type already carrying a charset
// is the case that separates "add one" from "replace it".
app.get("/compiled-string", (req, res) => {
    res.set("content-type", "text/html; charset=iso-8859-1");
    res.send("x");
});
app.get("/compiled-json-type", (req, res) => {
    res.set("content-type", "application/manifest+json");
    res.send("x");
});
// send only reaches for a type when none was chosen, so this one keeps text/plain
app.get("/compiled-object", (req, res) => {
    res.set("content-type", "text/plain");
    res.send({ a: 1 });
});
app.get("/compiled-boolean", (req, res) => {
    res.set("content-type", "text/plain");
    res.send(true);
});
app.get("/compiled-null", (req, res) => {
    res.set("content-type", "text/plain");
    res.send(null);
});
// and chooses one when none was
app.get("/compiled-object-bare", (req, res) => res.send({ a: 1 }));
app.get("/compiled-null-bare", (req, res) => res.send(null));

app.listen(13333, async () => {
    for (let i = 0; i < TYPES.length; i++) {
        const viaEnd = await fetchTest(`http://localhost:13333/set${i}`);
        await viaEnd.text();
        const viaSend = await fetchTest(`http://localhost:13333/send${i}`);
        await viaSend.text();
    }

    for (const path of [
        "/compiled-string",
        "/compiled-json-type",
        "/compiled-object",
        "/compiled-boolean",
        "/compiled-null",
        "/compiled-object-bare",
        "/compiled-null-bare"
    ]) {
        const response = await fetchTest("http://localhost:13333" + path);
        console.log(path, JSON.stringify(await response.text()));
    }

    process.exit(0);
});
