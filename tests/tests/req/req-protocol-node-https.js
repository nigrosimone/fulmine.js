// must answer https for an app handed to https.createServer, which only node's socket knows
// INSPECT

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

// https.get and not fetch: Deno's fetch ignores NODE_TLS_REJECT_UNAUTHORIZED
server.listen(13333, () => {
    https.get("https://localhost:13333/test", { rejectUnauthorized: false }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
            console.log(response.statusCode, body);
            server.close();
            process.exit(0);
        });
    });
});
