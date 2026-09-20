// What res.send() makes of the Content-Type the application set: express 5.3 parses and formats
// it with content-type 2, so the type is lowercased, the whitespace and quoting are normalised, a
// parameter it cannot read is dropped, and a type that is not one is an error

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const types = [
    "text/plain; charset=iso-8859-1",
    "TEXT/PLAIN; Charset=ISO-8859-1",
    "text/plain; foo=bar",
    "text/plain;foo=bar",
    "text/plain; foo",
    'text/plain; foo="a b"',
    "text/plain; a=b c",
    " text/plain ",
    "text/plain ; charset=utf-8",
    "text/plain; foo=bar; charset=latin1",
    "text/plain;;",
    "text/plain; charset=utf-8; charset=x",
    "text/plain; charset=",
    "text/plain; foo=bar;",
    'text/plain; a="unterminated',
    "application/json; charset=utf-8",
    "multipart/form-data; boundary=----x",
    "bad",
    "text"
];

const app = express();
app.set("etag", false);
types.forEach((type, i) => {
    app.get(`/${i}`, (req, res) => {
        res.set("Content-Type", type);
        res.send("x");
    });
    app.get(`/header/${i}`, (req, res) => {
        res.setHeader("Content-Type", type);
        res.send("x");
    });
});
app.use((err, req, res, next) => {
    res.status(500).type("txt").send(`${err.constructor.name}: ${err.message}`);
});

app.listen(13333, async () => {
    await sequential(
        types.flatMap((type, i) => [
            async () => {
                const res = await fetchTest(`http://localhost:13333/${i}`);
                console.log("set", JSON.stringify(type), await res.text());
            },
            async () => {
                const res = await fetchTest(`http://localhost:13333/header/${i}`);
                console.log("setHeader", JSON.stringify(type), await res.text());
            }
        ])
    );
    process.exit(0);
});
