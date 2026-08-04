// res.set() turns its value into text, and refuses an array for Content-Type
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/number", (req, res) => {
    res.set("X-Number", /** @type {any} */ (123));
    // read back through res.get, which has to answer what was sent and not what was passed in
    res.send(`get: ${JSON.stringify(res.get("X-Number"))}`);
});

app.get("/array", (req, res) => {
    res.set("X-Array", /** @type {any} */ ([123, 456]));
    res.send(`get: ${JSON.stringify(res.get("X-Array"))}`);
});

app.get("/object-form", (req, res) => {
    // the object form has to coerce and to add the charset, exactly as the two argument form does
    res.set({ "Content-Type": "text/plain", "X-Count": 7 });
    res.send(`type: ${res.get("Content-Type")} count: ${JSON.stringify(res.get("X-Count"))}`);
});

app.get("/array-content-type", (req, res) => {
    try {
        res.set("Content-Type", /** @type {any} */ (["text/html", "text/plain"]));
        res.send("no error");
    } catch (err) {
        res.send(`${err.constructor.name}: ${err.message}`);
    }
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/number", "/array", "/object-form", "/array-content-type"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
