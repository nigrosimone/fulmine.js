// must support req.connection and req.socket
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test", (req, res) => {
    console.log(req.connection.remoteAddress);
    console.log(req.connection.localPort);
    console.log(req.socket.remoteAddress);
    console.log(req.socket.localPort);
    console.log(typeof req.connection.remotePort); // should be a number (it's change randomly on each run because it's assigned by the OS)
    res.send("test");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    await fetchTest("http://localhost:13333/test").then((res) => res.text());

    process.exit(0);
});
