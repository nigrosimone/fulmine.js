// res.destroy() drops the connection, the way node's does
//
// A download whose source dies halfway has to leave the client with a broken connection rather than
// a short body it would take for the whole file, and the way an application says so is res.destroy()
// in the stream's error handler. Here that only tore the stream object down and left µWS holding an
// open connection with nothing more to send, so the client waited for bytes that were never coming.
// LibreChat's download route is written exactly this way, and its test for a stream that errors
// mid-transfer waited out its own timeout instead.

const express = require("express");
const { Readable } = require("stream");

const app = express();

app.get("/download", (req, res) => {
    let pushed = false;
    const source = new Readable({
        read() {
            if (!pushed) {
                pushed = true;
                this.push("partial content");
                return;
            }
            this.destroy(new Error("read failed mid-stream"));
        }
    });
    source.on("error", () => {
        if (res.headersSent) {
            if (!res.writableEnded) res.destroy();
            return;
        }
        res.status(500).send("error before the head went out");
    });
    res.setHeader("content-type", "application/octet-stream");
    source.pipe(res);
});

app.get("/after", (req, res) => res.send("the server is still serving"));

app.listen(13356, async () => {
    console.log("Server is running on port 13356");

    // the client cannot be told what broke, only that it broke: node and this project word the
    // reset differently, and both are read here as the same fact
    try {
        const res = await fetch("http://localhost:13356/download", { signal: AbortSignal.timeout(4000) });
        console.log("download answered:", res.status, JSON.stringify((await res.text()).slice(0, 40)));
    } catch (error) {
        const timedOut = /timeout|abort/i.test(String(error.message));
        console.log("download broke the connection:", !timedOut);
    }

    const after = await fetch("http://localhost:13356/after");
    console.log("and the next request is served:", await after.text());

    process.exit(0);
});
