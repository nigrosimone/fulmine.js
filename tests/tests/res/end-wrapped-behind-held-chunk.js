// a middleware that wraps res.end() and ignores a second call must not leave a held response open
// INSPECT

// express-session wraps res.end() this way: the first call goes through, a second one returns
// false. The handler writes until a piece is held back by a client that reads nothing, then ends.
// The end() that waits for the held piece used to come back through res.end, the wrapper, which
// took it for the application's second call and dropped it, so the response stayed open for good.
// Node queues the end behind the piece and never calls res.end again.

const express = require("express");
const net = require("net");

const app = express();
const PIECE = Buffer.alloc(64 * 1024, "x");
// enough to fill the loopback buffers on any platform, the cap only keeps a bug from writing forever
const MAX_PIECES = 2 * 1024;

/** @type {net.Socket} */
let client;

app.use((req, res, next) => {
    const end = res.end;
    let ended = false;
    res.end = function (...args) {
        if (ended) {
            return false;
        }
        ended = true;
        return end.apply(this, args);
    };
    next();
});

app.get("/stream", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    let pieces = 0;
    // write() saying false is where both frameworks hold the piece back
    while (res.write(PIECE) && ++pieces < MAX_PIECES);
    res.end();
    setTimeout(() => client.resume(), 100);
});

app.listen(13333, () => {
    const chunks = [];
    client = net.connect(13333, "127.0.0.1", () => {
        client.write("GET /stream HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        client.pause();
    });
    client.on("data", (chunk) => chunks.push(chunk));
    client.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        console.log("terminated:", body.endsWith("\r\n0\r\n\r\n"));
        process.exit(0);
    });
    setTimeout(() => {
        // printed, not thrown: the comparison then shows it against the other arm's line
        console.log("no end after 5s, the response was never closed");
        process.exit(0);
    }, 5000);
});
