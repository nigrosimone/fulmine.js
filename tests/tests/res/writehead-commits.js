// must treat writeHead as the head gone out, as node does: headersSent reads true from then on,
// setHeader, removeHeader and a second writeHead throw ERR_HTTP_HEADERS_SENT, and a status set
// later never reaches the wire. The bytes themselves still leave with the body

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

const attempt = (what, fn) => {
    try {
        fn();
        console.log(what, "ok");
    } catch (e) {
        console.log(what, "threw", e.code, JSON.stringify(e.message));
    }
};

app.get("/sent", (req, res) => {
    res.writeHead(201, { "X-A": "1" });
    console.log("headersSent after writeHead", res.headersSent);
    attempt("setHeader after writeHead", () => res.setHeader("X-B", "2"));
    attempt("removeHeader after writeHead", () => res.removeHeader("X-A"));
    attempt("second writeHead", () => res.writeHead(404, { "X-A": "3" }));
    attempt("res.set after writeHead", () => res.set("X-C", "4"));
    attempt("res.append after writeHead", () => res.append("X-A", "5"));
    console.log("getHeader after writeHead", res.getHeader("x-a"));
    res.end("x");
});
app.get("/flushed", (req, res) => {
    res.setHeader("X-F", "1");
    res.flushHeaders();
    console.log("headersSent after flushHeaders", res.headersSent);
    attempt("setHeader after flushHeaders", () => res.setHeader("X-G", "2"));
    res.end("y");
});
app.get("/status-later", (req, res) => {
    res.writeHead(202);
    res.status(203);
    console.log("statusCode read back", res.statusCode);
    res.end("s");
});
app.get("/status-assigned-later", (req, res) => {
    res.writeHead(202);
    res.statusCode = 204;
    res.end();
});
app.get("/message", (req, res) => {
    res.writeHead(200, "All Good", { "X-D": "4" });
    console.log("statusMessage", res.statusMessage);
    res.end("m");
});
app.get("/message-only", (req, res) => {
    res.writeHead(200, "Fine");
    console.log("stray header keys", JSON.stringify(Object.keys(res.getHeaders()).filter((k) => /^\d/.test(k))));
    res.end("o");
});
app.get("/array", (req, res) => {
    res.writeHead(200, ["X-G", "7", "X-H", "8"]);
    res.end("a");
});
app.get("/set-throws-to-handler", (req, res) => {
    res.writeHead(200);
    res.set("X-C", "3");
    res.end("never");
});
app.get("/writehead-then-write", (req, res) => {
    res.writeHead(200, { "X-W": "1" });
    res.write("pie");
    res.end("ces");
});

app.use((err, req, res, next) => {
    console.log("error handler", err.code, "headersSent", res.headersSent);
    if (res.headersSent) {
        return res.end();
    }
    res.status(500).send("handled");
});

app.listen(13333, async () => {
    for (const path of [
        "/sent",
        "/flushed",
        "/status-later",
        "/status-assigned-later",
        "/message",
        "/message-only",
        "/array",
        "/set-throws-to-handler",
        "/writehead-then-write"
    ]) {
        const response = await fetchTest("http://localhost:13333" + path);
        console.log(
            path,
            response.status,
            response.statusText,
            JSON.stringify(await response.text()),
            "x-a:",
            response.headers.get("x-a"),
            "x-d:",
            response.headers.get("x-d"),
            "x-g:",
            response.headers.get("x-g"),
            "x-w:",
            response.headers.get("x-w")
        );
    }
    process.exit(0);
});
