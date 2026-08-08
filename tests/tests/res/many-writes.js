// must deliver a body written in many small chunks whole, in order, and without holding it back
// INSPECT

// A chunked response is gathered before it reaches uWS, because uWS charges for a write against
// everything already buffered behind it and a page written in hundreds of pieces cost quadratically.
// Three things have to survive that: the bytes, their order, and the promptness of a lone write. The
// last one is what an earlier attempt at this got wrong, holding chunks for 50ms and breaking
// server-sent events.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// enough pieces, and small enough, to be gathered rather than passed straight through
app.get("/many", (req, res) => {
    res.type("text/plain");
    for (let i = 0; i < 300; i++) {
        res.write(`chunk ${i};`);
    }
    res.end("done");
});

// one piece over the gathering size: it leaves on its own, and the tail after it still follows
app.get("/mixed", (req, res) => {
    res.type("text/plain");
    res.write("head;");
    res.write("x".repeat(20 * 1024));
    res.write("tail;");
    res.end();
});

// a write with nothing behind it must not wait for company
app.get("/lonely", (req, res) => {
    res.type("text/plain");
    res.write("first;");
    setTimeout(() => {
        res.write("second;");
        res.end();
    }, 60);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const many = await fetchTest("http://localhost:13333/many").then((r) => r.text());
    console.log("many length", many.length);
    console.log("many starts", many.slice(0, 20));
    console.log("many ends", many.slice(-20));
    console.log("many in order", many.startsWith("chunk 0;chunk 1;chunk 2;"));
    console.log("many complete", many.includes("chunk 299;done"));

    const mixed = await fetchTest("http://localhost:13333/mixed").then((r) => r.text());
    console.log("mixed length", mixed.length);
    console.log("mixed order", mixed.startsWith("head;x") && mixed.endsWith("xtail;"));

    // the two halves have to arrive as two, 60ms apart: gathered into one they would arrive together
    const response = await fetchTest("http://localhost:13333/lonely");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const seen = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        seen.push(decoder.decode(value, { stream: true }));
    }
    console.log("lonely pieces", seen.length > 1);
    console.log("lonely body", seen.join(""));

    process.exit(0);
});
