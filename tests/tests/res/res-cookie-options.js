// res.cookie() with no secret to sign with, and with a maxAge that is not a number
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/signed-without-secret", (req, res) => {
    try {
        res.cookie("name", "value", { signed: true });
        res.send("no error");
    } catch (err) {
        // the message names what is missing rather than the library that noticed
        res.send(`${err.constructor.name}: ${err.message}`);
    }
});

app.get("/null-max-age", (req, res) => {
    res.cookie("name", "value", { maxAge: /** @type {any} */ (null) });
    res.send("set");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/signed-without-secret", "/null-max-age"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, JSON.stringify(res.headers.getSetCookie()), await res.text());
    }

    process.exit(0);
});
