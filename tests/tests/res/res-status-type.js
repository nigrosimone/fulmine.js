// res.status() refuses a code that is not an integer, and says which kind of wrong it is
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// a string that looks like a status code is still not an integer, and Express says so rather than
// parsing it: the two ways of being wrong have their own error types
const CASES = [
    ["string", "200"],
    ["fraction", 200.5],
    ["missing", undefined],
    ["low", 99],
    ["high", 1000]
];

for (const [name, code] of CASES) {
    app.get(`/${name}`, (req, res) => {
        try {
            res.status(/** @type {any} */ (code));
            res.send("no error");
        } catch (err) {
            res.send(`${err.constructor.name}: ${err.message}`);
        }
    });
}

app.get("/send-status", (req, res) => {
    try {
        res.sendStatus(/** @type {any} */ (undefined));
    } catch (err) {
        res.send(`${err.constructor.name}: ${err.message}`);
    }
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const [name] of CASES) {
        const res = await fetchTest(`http://localhost:13333/${name}`);
        console.log(name, await res.text());
    }
    const res = await fetchTest("http://localhost:13333/send-status");
    console.log("sendStatus", await res.text());

    process.exit(0);
});
