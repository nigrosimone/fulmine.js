// A Transfer-Encoding the application set itself, then end() or write(): node frames the body
// chunked by that header and adds no Content-Length, and uWS must do the same rather than append
// a length beside it. send() under the same header is res/send-with-transfer-encoding.js

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);
app.get("/end", (req, res) => {
    res.set("Transfer-Encoding", "chunked");
    res.end("hello");
});
app.get("/end-buffer", (req, res) => {
    res.setHeader("Transfer-Encoding", "chunked");
    res.end(Buffer.from("hello"));
});
app.get("/end-empty", (req, res) => {
    res.setHeader("Transfer-Encoding", "chunked");
    res.end();
});
app.get("/write", (req, res) => {
    res.set("Transfer-Encoding", "chunked");
    res.write("hel");
    res.end("lo");
});
app.get("/write-end", (req, res) => {
    res.set("Transfer-Encoding", "chunked");
    res.write("hel");
    res.write("lo");
    res.end();
});
app.get("/writehead", (req, res) => {
    res.writeHead(200, { "Transfer-Encoding": "chunked" });
    res.end("hello");
});
app.get("/status", (req, res) => {
    res.status(201).set("Transfer-Encoding", "chunked");
    res.end("made");
});
app.get("/plain", (req, res) => {
    res.end("hello");
});

app.listen(13333, async () => {
    const paths = ["/end", "/end-buffer", "/end-empty", "/write", "/write-end", "/writehead", "/status", "/plain"];
    await sequential(
        paths.flatMap((path) => [
            async () => {
                const res = await fetchTest(`http://localhost:13333${path}`);
                console.log("GET", path, JSON.stringify(await res.text()));
            },
            async () => {
                const res = await fetchTest(`http://localhost:13333${path}`, { method: "HEAD" });
                console.log("HEAD", path, JSON.stringify(await res.text()));
            }
        ])
    );
    process.exit(0);
});
