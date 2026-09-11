// a header name that is not a token, and a value with a CRLF in it, are what setHeader throws on:
// the answer is the error page, not a header. Every handler here is a shape the declarative
// compiler takes, which is where these used to reach the wire unchecked.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("env", "production");
app.set("etag", false);

app.get("/set", (req, res) => {
    res.set("bad name", "v");
    res.send("ok");
});
app.get("/set-object", (req, res) => {
    res.set({ "bad name": "v" });
    res.send("ok");
});
app.get("/header", (req, res) => {
    res.header("bad name", "v");
    res.send("ok");
});
app.get("/set-header", (req, res) => {
    res.setHeader("bad name", "v");
    res.send("ok");
});
app.get("/append", (req, res) => {
    res.append("bad name", "v");
    res.send("ok");
});
app.get("/colon", (req, res) => {
    res.set("x:a", "v");
    res.send("ok");
});
app.get("/empty-name", (req, res) => {
    res.set("", "v");
    res.send("ok");
});
app.get("/crlf-value", (req, res) => {
    res.set("X-A", "a\r\nb");
    res.send("ok");
});
app.get("/crlf-append", (req, res) => {
    res.append("X-A", "a\r\nb");
    res.send("ok");
});
// the control: a name and a value both fine still answer with the header
app.get("/good", (req, res) => {
    res.set("X-A", "v");
    res.send("ok");
});

const paths = [
    "/set",
    "/set-object",
    "/header",
    "/set-header",
    "/append",
    "/colon",
    "/empty-name",
    "/crlf-value",
    "/crlf-append",
    "/good"
];

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(
        paths.map((path) => async () => {
            const res = await fetchTest("http://localhost:13333" + path);
            console.log(path, res.status, JSON.stringify(res.headers.get("x-a")), await res.text());
        })
    );
    process.exit(0);
});
