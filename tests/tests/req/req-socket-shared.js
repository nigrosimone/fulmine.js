// req.socket and res.socket are one object, and it answers what a node socket answers
//
// node hands the same socket to both, and middleware relies on it: one half of a library sets
// something on req.socket and the other half reads it off res.socket. Here they were two different
// stand-ins, one carrying the address and the other the events, so an application got whichever
// half it happened to ask for. The members below are the ones an application calls on a request it
// means to hold open or drop; what they do is this project's business, that they are there and
// hand back what node hands back is Express's.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/socket", (req, res) => {
    const socket = req.socket;
    const shapes = {};
    for (const name of [
        "on",
        "once",
        "emit",
        "removeListener",
        "setTimeout",
        "setKeepAlive",
        "setNoDelay",
        "destroy",
        "pause",
        "resume",
        "write",
        "end",
        "address",
        "ref",
        "unref"
    ]) {
        shapes[name] = typeof socket[name];
    }
    res.json({
        same: req.socket === res.socket,
        stable: req.socket === req.socket,
        connectionToo: req.connection === res.socket,
        shapes,
        tuningReturnsTheSocket: [
            socket.setTimeout(0) === socket,
            socket.setKeepAlive(true) === socket,
            socket.setNoDelay(true) === socket,
            socket.ref() === socket,
            socket.unref() === socket
        ],
        state: {
            readyState: socket.readyState,
            connecting: socket.connecting,
            pending: socket.pending,
            destroyed: socket.destroyed,
            writable: socket.writable,
            addressPort: typeof socket.address().port,
            remoteAddress: typeof socket.remoteAddress,
            remotePort: typeof socket.remotePort
        }
    });
});

app.listen(13353, async () => {
    console.log("Server is running on port 13353");
    await fetchTest("http://localhost:13353/socket").then((res) => res.text().then((text) => console.log(text)));
    process.exit(0);
});
