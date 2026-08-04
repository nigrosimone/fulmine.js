// req.connection and req.socket are one object, stable across reads, with a usable remotePort
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test", (req, res) => {
    const port = req.connection.remotePort;
    res.send(
        `stable=${req.connection === req.connection}` +
            ` same=${req.socket === req.connection}` +
            ` port=${Number.isInteger(port) && port > 0}` +
            ` address=${typeof req.connection.remoteAddress}`
    );
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const res = await fetchTest("http://localhost:13333/test");
    console.log(await res.text());

    process.exit(0);
});
