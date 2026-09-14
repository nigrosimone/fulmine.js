// must report the peer of a request that arrived through node's own server as node reports it

const express = require("express");
const http = require("http");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.get("/ip", (req, res) => res.send(`${req.ip} ${req.socket.remoteAddress} ${JSON.stringify(req.ips)}`));

// The app is handed to http.createServer, which is the path supertest takes, and the server is
// bound to an IPv4 address on purpose: node reports the peer of a dual stack listener mapped,
// "::ffff:127.0.0.1", and the peer of this one plain, so this is the form every host agrees on
// whether or not it has IPv6. listen() never reaches the app here, so nothing about the socket is
// known except what node says about it, which is the whole point.
const server = http.createServer(app);

server.listen(0, "127.0.0.1", async () => {
    const res = await fetchTest(`http://127.0.0.1:${server.address().port}/ip`);
    console.log(await res.text());
    process.exit(0);
});
