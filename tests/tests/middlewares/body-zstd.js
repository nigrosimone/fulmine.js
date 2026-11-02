// a zstd body is inflated as body-parser 2.4 does, cut short or over the limit it is refused
// INSPECT

const express = require("express");
const zlib = require("zlib");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.post("/json", express.json(), (req, res) => res.json(req.body));
app.post("/text", express.text(), (req, res) => res.json(req.body));
app.post("/limit", express.raw({ limit: "8b" }), (req, res) => res.json(String(req.body)));
app.use((err, req, res, next) =>
    res
        .status(err.status || 500)
        .type("txt")
        .send(`${err.type ?? "no type"}: ${err.message}`)
);

// node without zstd answers 415 on both sides, as body-parser checks the same thing
const zstd = (text) => ("zstdCompressSync" in zlib ? zlib.zstdCompressSync(Buffer.from(text)) : Buffer.from(text));
const json = zstd('{"name":"tobi","list":[1,2,3]}');

const cases = [
    ["/json", "application/json", json],
    ["/json", "application/json", json.subarray(0, json.length - 3)],
    ["/json", "application/json", Buffer.from("not zstd at all")],
    ["/text", "text/plain", zstd("hello zstd")],
    ["/limit", "application/octet-stream", zstd("bytes")],
    ["/limit", "application/octet-stream", zstd("far more than eight bytes once inflated")]
].map(([path, type, body]) => async () => {
    const res = await fetchTest("http://localhost:13333" + path, {
        method: "POST",
        headers: { "content-type": type, "content-encoding": "zstd" },
        body
    });
    console.log(path, body.length, res.status, await res.text());
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(cases);
    process.exit(0);
});
