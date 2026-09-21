// end() right behind a small chunk a slow client has not taken yet must still close the response
// INSPECT

// The client stops reading, the handler writes 4 KB pieces until one is held back by the socket,
// and ends the response on it. A piece that small never makes write() say false, so no 'drain'
// follows, and an end() that waited for one left the response open for good: the compression
// middleware ends a gzip stream exactly like this, on its last small piece, and a loaded machine
// made the client slow enough to hang it (2026-09-21). Node queues the end behind the piece.

const express = require("express");
const net = require("net");

const app = express();
const PIECE = Buffer.alloc(4 * 1024, "x");
// enough to fill the loopback buffers on any platform, the cap only keeps a bug from writing forever
const MAX_PIECES = 32 * 1024;

/** @type {net.Socket} */
let client;

app.get("/stream", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    let pieces = 0;
    const write = () => {
        res.write(PIECE);
        pieces++;
        // what the framework has not handed to the kernel yet: node counts the socket's, this the
        // piece uWS holds
        if (res.writableLength > 0 || pieces === MAX_PIECES) {
            res.end();
            client.resume();
            return;
        }
        setImmediate(write);
    };
    write();
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
