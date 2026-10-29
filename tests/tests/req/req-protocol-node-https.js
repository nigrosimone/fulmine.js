// must answer https for an app handed to https.createServer, which only node's socket knows
// INSPECT
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // ignore self-signed certificate error

const express = require("express");
const https = require("https");
const fs = require("fs");

// both arms through node's TLS server: the app has no ssl option, so the socket is the only witness
const app = express();
app.get("/test", (req, res) => {
    res.json({ protocol: req.protocol, secure: req.secure, encrypted: Boolean(req.socket.encrypted) });
});

const server = https.createServer(
    {
        key: fs.readFileSync("tests/parts/localhost.key", "utf8"),
        cert: fs.readFileSync("tests/parts/localhost.crt", "utf8")
    },
    app
);

server.listen(13333, async () => {
    const response = await fetch("https://localhost:13333/test");
    console.log(response.status, await response.text());
    server.close();
    process.exit(0);
});
