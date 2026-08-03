// app.listen() with no arguments must bind an OS-assigned TCP port, like node's server.listen()

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/ping", (req, res) => res.send("pong"));

const server = app.listen();

setTimeout(async () => {
    const addr = server.address();
    // the port itself is random, so only its shape is printed
    console.log(
        "family:",
        addr && addr.family,
        "port assigned:",
        !!addr && Number.isInteger(addr.port) && addr.port > 0
    );

    const res = await fetchTest(`http://localhost:${addr.port}/ping`);
    console.log(await res.text());

    // listen(undefined, cb) is the same shape with a callback
    const app2 = express();
    const server2 = app2.listen(undefined, () => {
        const addr2 = server2.address();
        console.log("undefined port assigned:", !!addr2 && Number.isInteger(addr2.port) && addr2.port > 0);
        process.exit(0);
    });
}, 200);
