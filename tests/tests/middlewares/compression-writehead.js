// must compress a response whose head the handler wrote itself, as the compression module does
// through on-headers: the decision is taken at writeHead, with the headers it carries applied
// first, so a Content-Length given there is the one the decision removes

const express = require("express");
const compression = express.compression || require("compression");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);
app.use(compression({ threshold: 1024 }));

const BIG = "Hello World".repeat(500);

app.get("/end", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(BIG.length) });
    res.end(BIG);
});
app.get("/pieces", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write(BIG.slice(0, 2000));
    res.end(BIG.slice(2000));
});
// the size is not known at the head, so the threshold cannot say no
app.get("/small", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("small");
});
app.get("/small-with-length", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "5" });
    res.end("small");
});
app.get("/png", (req, res) => {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(Buffer.alloc(4096, 7));
});
app.get("/no-transform", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-transform" });
    res.end(BIG);
});
app.get("/reason-shape", (req, res) => {
    res.writeHead(200, "Fine", { "Content-Type": "text/plain" });
    res.end(BIG);
});

app.listen(13333, async () => {
    for (const [path, accept] of [
        ["/end", "gzip"],
        ["/pieces", "gzip"],
        ["/small", "gzip"],
        ["/small-with-length", "gzip"],
        ["/png", "gzip"],
        ["/no-transform", "gzip"],
        ["/reason-shape", "gzip"],
        ["/end", "identity"]
    ]) {
        const response = await fetchTest("http://localhost:13333" + path, {
            headers: { "accept-encoding": accept }
        });
        const body = await response.text();
        console.log(
            path,
            accept,
            response.status,
            response.statusText,
            "encoding:",
            response.headers.get("content-encoding"),
            "vary:",
            response.headers.get("vary"),
            "length:",
            body.length
        );
    }
    process.exit(0);
});
