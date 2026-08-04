// through node's own HTTP server the wire carries node's truthful Keep-Alive timeout
// INSPECT

const express = require("express");
const http = require("http");
const net = require("net");

async function sendRequest(port, extraHeaders) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        client.connect(port, "127.0.0.1", () => {
            client.write(`GET /x HTTP/1.1\r\nHost: localhost\r\n${extraHeaders}\r\n`);
        });
        let data = "";
        client.on("data", (chunk) => {
            data += chunk.toString();
            // keep-alive requests leave the socket open, so read one response and go
            client.destroy();
            resolve(data);
        });
    });
}

const app = express();
app.get("/x", (req, res) => res.send("ok"));

const server = http.createServer(app);

server.listen(0, async () => {
    console.log("Server is running");
    const port = server.address().port;

    // node enforces its own keepAliveTimeout here, so the advertised value must be node's
    const alive = await sendRequest(port, "");
    console.log(
        alive
            .split("\r\n")
            .map((line) => line.toLowerCase())
            .filter((line) => line.startsWith("connection:") || line.startsWith("keep-alive:"))
    );

    // an explicit close still passes through
    const closed = await sendRequest(port, "Connection: close\r\n");
    console.log(
        closed
            .split("\r\n")
            .map((line) => line.toLowerCase())
            .filter((line) => line.startsWith("connection:") || line.startsWith("keep-alive:"))
    );
    process.exit(0);
});
