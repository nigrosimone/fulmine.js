// a file that disappears between the stat and the read reaches the error handler, not the process
// INSPECT

const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();

app.get("/gone", (req, res) => {
    const file = path.join(os.tmpdir(), `fulmine-stream-read-error-${process.pid}.bin`);
    // over the worker-path threshold, so the streamed branch serves it
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024));
    res.sendFile(file);
    // gone before the async open: the read errors and must be routed to next()
    fs.unlinkSync(file);
});

app.use((err, req, res, next) => {
    res.status(err.status || 500).send(`error-mw: ${err.code}`);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const response = await fetch("http://localhost:13333/gone");
    console.log(response.status, await response.text());
    process.exit(0);
});
