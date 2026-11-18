// a gzip, deflate or brotli body that inflates past the limit is a 413 from every parser, with the fields body-parser gives it

const express = require("express");
const zlib = require("zlib");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.post("/json", express.json(), (req, res) => res.json(req.body));
app.post("/urlencoded", express.urlencoded(), (req, res) => res.json(req.body));
app.post("/raw", express.raw({ limit: "1kb" }), (req, res) => res.json(req.body.length));
app.post("/text", express.text({ limit: 1000 }), (req, res) => res.json(req.body.length));
// received is left out: body-parser counts what the stream had handed over when it stopped
app.use((err, req, res, next) =>
    res
        .status(err.status || 500)
        .type("txt")
        .send(`${err.type ?? "no type"}: ${err.message} (limit ${err.limit}, expose ${err.expose})`)
);

// 8 MB of the same byte, a few kilobytes once compressed: one chunk on the wire
const bomb = Buffer.alloc(8 * 1024 * 1024, "1");
const compressors = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync };

const cases = [];
for (const [path, type] of [
    ["/json", "application/json"],
    ["/urlencoded", "application/x-www-form-urlencoded"],
    ["/raw", "application/octet-stream"],
    ["/text", "text/plain"]
]) {
    for (const [encoding, compress] of Object.entries(compressors)) {
        cases.push(async () => {
            const res = await fetchTest(
                "http://localhost:13333" + path,
                {
                    method: "POST",
                    headers: { "content-type": type, "content-encoding": encoding },
                    body: compress(bomb)
                },
                { refusedForSize: true }
            );
            console.log(path, encoding, res.status, await res.text());
        });
    }
}
// exactly the limit inflated is still read, one byte more is not
for (const size of [1024, 1025]) {
    cases.push(async () => {
        const res = await fetchTest(
            "http://localhost:13333/raw",
            {
                method: "POST",
                headers: { "content-type": "application/octet-stream", "content-encoding": "gzip" },
                body: zlib.gzipSync(Buffer.alloc(size, "a"))
            },
            { refusedForSize: size > 1024 }
        );
        console.log("/raw", size, res.status, await res.text());
    });
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(cases);
    process.exit(0);
});
