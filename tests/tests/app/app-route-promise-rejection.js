// test that a rejected promise out of a handler registered through app.route() reaches the error
// handlers, with its value, without one, and out of an error handler too

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

const withValue = app.route("/with-value");
withValue.all(() => Promise.reject(new Error("boom!")));
withValue.all((req, res) => res.send("not reached"));
withValue.all((err, req, res, next) => res.status(500).send("caught: " + err.message));

const bare = app.route("/bare");
bare.all(() => Promise.reject());
bare.all((req, res) => res.send("not reached"));
bare.all((err, req, res, next) => res.status(500).send("caught: " + err.message));

const chained = app.route("/chained");
chained.all(() => Promise.reject(new Error("boom!")));
chained.all((err, req, res, next) => Promise.reject(new Error("caught: " + err.message)));
chained.all((err, req, res, next) => res.status(500).send("caught again: " + err.message));

app.listen(13333, async () => {
    for (const path of ["/with-value", "/bare", "/chained"]) {
        const res = await fetchTest("http://localhost:13333" + path);
        console.log(path, "->", await res.text());
    }
    process.exit(0);
});
