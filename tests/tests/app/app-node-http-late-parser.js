// a body parser behind async middleware must still get the whole body through node's server

const express = require("express");
const http = require("http");

// Through http.createServer(app) the body arrives on node's stream, and a chunk can land before the
// parser has attached its reader. The parser attaching late, behind async middleware, is the normal
// shape of an app, and the early chunk has to reach it rather than vanish into the first reader.
const app = express();

app.use((req, res, next) => setTimeout(next, 30));
app.post("/json", express.json(), (req, res) => res.json({ got: req.body }));
app.post("/text", express.text(), (req, res) => res.json({ got: req.body }));
app.use((err, req, res, next) => res.status(err.status || 500).json({ err: err.message, type: err.type }));

/** POSTs a body split across two TCP writes 60ms apart, so a chunk arrives before the parser. */
function post(port, route, body, type, chunked) {
    return new Promise((resolve) => {
        const headers = { "content-type": type };
        if (!chunked) {
            headers["content-length"] = Buffer.byteLength(body);
        }
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: route, headers }, (res) => {
            let out = "";
            res.on("data", (chunk) => (out += chunk));
            res.on("end", () => resolve(`${res.statusCode} ${out}`));
        });
        const half = Math.floor(body.length / 2);
        req.flushHeaders();
        req.write(body.slice(0, half));
        setTimeout(() => req.end(body.slice(half)), 60);
    });
}

const server = http.createServer(app);

server.listen(0, async () => {
    const port = server.address().port;
    const body = JSON.stringify({ a: "b", n: [1, 2, 3] });

    console.log("json split", await post(port, "/json", body, "application/json", false));
    // chunked transfer has no length check to catch a lost chunk, only the parsed bytes themselves
    console.log("json chunked split", await post(port, "/json", body, "application/json", true));
    console.log("text split", await post(port, "/text", "one two three", "text/plain", false));

    server.close();
    process.exit(0);
});
