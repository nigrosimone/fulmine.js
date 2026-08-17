// must tell the response the client hung up, whether or not the handler writes again
//
// `res.on("close", ...)` is how code learns the visitor has gone and stops working for them. Every
// proxy and every streaming endpoint hangs its cancellation on it. Node emits it when the connection
// goes, in the order 'aborted' on the request, 'close' on the response, 'close' on the request.
//
// The second route is the one that matters and the first one hides it: a handler that keeps writing
// finds out anyway, because the write itself fails. A handler that has sent the head and is waiting
// for something, which is what an SSE endpoint or anything in front of a slow upstream looks like,
// writes nothing and has only this event to go on.
//
// A raw request, because the socket has to be destroyed mid-response and fetch cannot do that.

const express = require("express");
const http = require("http");

const app = express();
app.set("etag", false);

/** @type {Record<string, string[]>} */
const fired = { idle: [], writing: [] };

/** Records the four events node emits around a client abort, in the order they arrive. */
function record(name, req, res) {
    res.on("close", () => fired[name].push("res close"));
    res.on("error", (err) => fired[name].push(`res error ${err.code ?? err.message}`));
    req.on("aborted", () => fired[name].push("req aborted"));
    req.on("close", () => fired[name].push("req close"));
}

// the head goes out, and then nothing ever again
app.get("/idle", (req, res) => {
    res.set("content-type", "text/plain");
    res.write("first");
    record("idle", req, res);
});

// the same, and then one write long after the client has gone
app.get("/writing", (req, res) => {
    res.set("content-type", "text/plain");
    res.write("first");
    record("writing", req, res);
    setTimeout(() => {
        fired.writing.push(`late write returned ${res.write("late")}`);
    }, 150);
});

/**
 * Asks for a path and destroys the socket as soon as the first byte of body arrives, which is what
 * a browser does when the tab closes. Resolves once the server has had time to notice.
 */
function askAndHangUp(path) {
    return new Promise((resolve) => {
        const request = http.get({ host: "127.0.0.1", port: 13333, path }, (response) => {
            response.on("data", () => request.destroy());
        });
        request.on("error", () => {});
        setTimeout(resolve, 400);
    });
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    await askAndHangUp("/idle");
    console.log("idle   ", JSON.stringify(fired.idle));

    await askAndHangUp("/writing");
    console.log("writing", JSON.stringify(fired.writing));

    process.exit(0);
});
