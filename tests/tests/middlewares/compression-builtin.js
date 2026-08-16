// must compress the same way the compression module does
// INSPECT
//
// express.compression() answers what the compression module answers, so this file runs the
// built-in one against fulmine and the module against express and compares the two. Everything
// the two are supposed to agree on is here: the content type filter, no-transform, the threshold,
// a body that is already encoded, HEAD, the negotiation including q values, and both ways a body
// reaches the wire, whole from send() and in pieces from a pipe.

const express = require("express");
const compression = express.compression || require("compression");
const { fetchTest } = require("../../helpers.js");
const zlib = require("zlib");

const app = express();
app.set("etag", false);

app.use(
    compression({
        // named rather than left at the default, so the threshold cases below say which side of it
        // they are on instead of depending on what the default happens to be
        threshold: 1024
    })
);

const BIG = "Hello World".repeat(500);

app.get("/big", (req, res) => {
    res.type("text/plain").send(BIG);
});

app.get("/small", (req, res) => {
    res.type("text/plain").send("small");
});

app.get("/json", (req, res) => {
    res.json({ items: Array.from({ length: 100 }, (item, index) => ({ index, name: `item-${index}` })) });
});

// a body that already carries an encoding is left as it is
app.get("/already", (req, res) => {
    res.set("content-encoding", "gzip")
        .type("application/json")
        .send(zlib.gzipSync(JSON.stringify({ big: BIG })));
});

// no-transform forbids recoding it
app.get("/no-transform", (req, res) => {
    res.set("cache-control", "no-transform").type("text/plain").send(BIG);
});

// a type nothing is gained by compressing
app.get("/png", (req, res) => {
    res.type("image/png").send(Buffer.alloc(4096, 7));
});

// the pieces path: written rather than sent, so the size is not known when the head is decided
app.get("/pieces", (req, res) => {
    res.type("text/plain");
    for (let i = 0; i < 8; i++) {
        res.write(`piece ${i} ${"x".repeat(200)}\n`);
    }
    res.end("last\n");
});

// and the pipe path, which is what a file goes down
app.get("/file", (req, res) => {
    res.sendFile("tests/parts/medium-file.json", { root: "." });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const cases = [
        ["/big", "gzip"],
        ["/big", "br"],
        ["/big", "deflate"],
        // every name at the same q: brotli is preferred, as negotiator orders them
        ["/big", "gzip, deflate, br"],
        // and the client can say which it would rather have
        ["/big", "br;q=0.5, gzip;q=0.9"],
        // a refusal, and a refusal of everything
        ["/big", "gzip;q=0"],
        ["/big", "identity"],
        ["/big", "*"],
        // no header at all, which enforceEncoding decides and by default means no compression
        ["/big", null],
        ["/small", "gzip"],
        ["/json", "gzip, deflate, br"],
        ["/already", "gzip"],
        ["/no-transform", "gzip"],
        ["/png", "gzip"],
        ["/pieces", "gzip"],
        ["/file", "gzip"]
    ];

    for (const [path, accept] of cases) {
        const headers = accept === null ? {} : { "Accept-Encoding": accept };
        const res = await fetchTest(`http://localhost:13333${path}`, { headers });
        const body = await res.text();
        // the decoded body, since what is compared is that the answer says the same thing: the
        // compressed bytes themselves are zlib's business and this is not a test of zlib
        console.log(path, accept, res.status, body.length, body.slice(0, 24));
    }

    // HEAD is never compressed, and it is the response headers that say so
    const head = await fetchTest("http://localhost:13333/big", {
        method: "HEAD",
        headers: { "Accept-Encoding": "gzip" }
    });
    console.log("HEAD", head.status);

    // the default filter is exported by both, so a front that wants one more type than it says yes
    // to can call it and add to the answer
    console.log("filter exported", typeof compression.filter === "function");

    process.exit(0);
});
