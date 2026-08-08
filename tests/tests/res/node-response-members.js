// must have the response members node has, honouring the ones it can and ignoring the rest
// INSPECT

// node's ServerResponse has writeEarlyHints, writeContinue and writeProcessing, and the types this
// package re-exports promise all three. µWebSockets.js has no API for a 1xx, so none of them can
// reach the wire, but an Express application that calls one has to keep running rather than die on
// "is not a function". They exist, they do nothing, and the callback is still called.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/hints", (req, res) => {
    let called = false;
    res.writeEarlyHints({ link: "</main.js>; rel=preload; as=script" }, () => {
        called = true;
    });
    res.addTrailers({ "x-trailing": "ignored" });
    res.setTimeout(5000);
    res.json({
        callbackCalled: called,
        stillHere: true,
        // called for real they would put a 100 and a 102 on the wire that nobody asked for, and
        // node's own client rejects an unsolicited 100 as a protocol error. What matters for a
        // drop-in is that they are there at all
        writeContinue: typeof res.writeContinue,
        writeProcessing: typeof res.writeProcessing,
        assignSocket: typeof res.assignSocket,
        detachSocket: typeof res.detachSocket,
        getRawHeaderNames: typeof res.getRawHeaderNames
    });
});

app.get("/headers", (req, res) => {
    res.setHeader("x-one", "1");
    res.appendHeader("x-one", "2");
    res.appendHeader("x-two", "fresh");
    res.statusMessage = "Totally Fine";
    res.json({
        hasOne: res.hasHeader("X-One"),
        hasNothing: res.hasHeader("x-absent"),
        one: res.getHeader("x-one"),
        two: res.getHeader("x-two"),
        names: res
            .getHeaderNames()
            .filter((n) => n.startsWith("x-") && n !== "x-powered-by")
            .sort(),
        statusMessage: res.statusMessage
    });
});

app.get("/set-headers", (req, res) => {
    res.setHeaders(new Map([["x-from-map", "yes"]]));
    res.setHeaders(new Headers({ "x-from-headers": "also" }));
    res.json({ map: res.getHeader("x-from-map"), headers: res.getHeader("x-from-headers") });
});

app.get("/after", (req, res) => {
    res.write("body;");
    // node throws once the head has gone out, and so must we: an application may rely on it
    try {
        res.writeEarlyHints({ link: "</late.js>; rel=preload; as=script" });
        res.end("no throw");
    } catch (error) {
        res.end("threw " + error.code);
    }
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const hints = await fetchTest("http://localhost:13333/hints");
    console.log("status", hints.status);
    console.log("body", await hints.text());
    // nothing of the hint may appear on the response itself
    console.log("no link header", hints.headers.get("link"));

    const after = await fetchTest("http://localhost:13333/after");
    console.log("after status", after.status);
    console.log("after body", await after.text());

    const headers = await fetchTest("http://localhost:13333/headers");
    console.log("headers body", await headers.text());
    console.log("reason phrase", headers.statusText);

    const setHeaders = await fetchTest("http://localhost:13333/set-headers");
    console.log("setHeaders body", await setHeaders.text());

    process.exit(0);
});
