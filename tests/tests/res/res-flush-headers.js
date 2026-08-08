// must support res.flushHeaders()
// INSPECT
//
// node's OutgoingMessage sends the status line and the headers as soon as this is called, without
// waiting for a body, so a client can start on the head while the body is still being produced.
// Anything that streams a response into `res` reaches for it, and `@angular/ssr`'s
// writeResponseToNodeResponse is one of them: it calls flushHeaders before writing the rendered
// document, so a server without it cannot serve an Angular application at all.
//
// The cases that matter are the ones where it changes the framing or must refuse to act: a flushed
// response is chunked because its length is not known yet, a second call does nothing, headers set
// after the flush cannot go out, and a response that never flushes keeps its content-length.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.get("/flushed", (req, res) => {
    res.statusCode = 201;
    res.setHeader("x-decided-early", "yes");
    res.setHeader("content-type", "text/plain");
    res.flushHeaders();
    res.write("first ");
    setTimeout(() => {
        res.write("second");
        res.end();
    }, 10);
});

// a second call is a no-op, as node's is
app.get("/twice", (req, res) => {
    res.setHeader("content-type", "text/plain");
    res.flushHeaders();
    res.flushHeaders();
    res.end("body");
});

// after the flush the head has gone, so setting a header is the same error as after any other send
app.get("/too-late", (req, res) => {
    res.setHeader("content-type", "text/plain");
    res.flushHeaders();
    try {
        res.setHeader("x-late", "no");
        res.end("no throw");
    } catch (err) {
        res.end("threw: " + err.message);
    }
});

// headersSent reports what it did
app.get("/sent-flag", (req, res) => {
    const before = res.headersSent;
    res.flushHeaders();
    res.end(JSON.stringify({ before, after: res.headersSent }));
});

// a response that never flushes keeps the length it always had
app.get("/not-flushed", (req, res) => {
    res.type("text/plain").send("no flush here");
});

// flushing a status that carries no body
app.get("/no-body-status", (req, res) => {
    res.statusCode = 204;
    res.flushHeaders();
    res.end();
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/flushed", "/twice", "/too-late", "/sent-flag", "/not-flushed", "/no-body-status"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(
            path,
            res.status,
            "te=" + res.headers.get("transfer-encoding"),
            "cl=" + res.headers.get("content-length"),
            "early=" + res.headers.get("x-decided-early"),
            "late=" + res.headers.get("x-late"),
            JSON.stringify(await res.text())
        );
    }

    process.exit(0);
});
