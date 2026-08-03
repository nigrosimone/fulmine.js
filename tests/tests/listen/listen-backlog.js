// test that listen(port, host, backlog, callback) calls the callback, node's four-argument shape

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/", (req, res) => res.send("ok"));

const server = app.listen(13333, "127.0.0.1", 5, async () => {
    const { address } = server.address();
    console.log("callback called, address:", address);
    const res = await fetchTest("http://127.0.0.1:13333/");
    console.log("body:", await res.text());
    process.exit(0);
});
