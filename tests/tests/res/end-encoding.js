// must apply the encoding res.end is given to a string body, as node does, and call the callback
// of the three-argument shape: res.end(data, "binary") is how old code sends an image

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/end-latin1", (req, res) => {
    res.setHeader("Content-Type", "application/octet-stream");
    res.end("é", "latin1");
});
app.get("/end-base64", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end("aGVsbG8=", "base64");
});
app.get("/end-binary", (req, res) => {
    res.setHeader("Content-Type", "application/octet-stream");
    res.end("ÿþ", "binary");
});
app.get("/end-hex", (req, res) => {
    res.setHeader("Content-Type", "application/octet-stream");
    res.end("6869", "hex");
});
app.get("/end-utf8", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end("é", "utf8");
});
app.get("/end-buffer-cb", (req, res) => {
    res.end(Buffer.from("buf"), () => console.log("end cb ran"));
});
app.get("/end-enc-cb", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end("aGk=", "base64", () => console.log("end cb with encoding ran"));
});
app.get("/write-base64", (req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.write("aGVsbG8=", "base64");
    res.end();
});
app.get("/write-latin1-end-latin1", (req, res) => {
    res.setHeader("Content-Type", "application/octet-stream");
    res.write("é", "latin1");
    res.end("è", "latin1");
});

app.listen(13333, async () => {
    for (const path of [
        "/end-latin1",
        "/end-base64",
        "/end-binary",
        "/end-hex",
        "/end-utf8",
        "/end-buffer-cb",
        "/end-enc-cb",
        "/write-base64",
        "/write-latin1-end-latin1"
    ]) {
        const response = await fetchTest("http://localhost:13333" + path);
        console.log(path, response.status, Buffer.from(await response.arrayBuffer()).toString("hex"));
    }
    process.exit(0);
});
