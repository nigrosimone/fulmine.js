// must parse bodies identically whether they arrive in one chunk, many chunks, or compressed
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const zlib = require("zlib");
const crypto = require("crypto");

const app = express();

app.use(express.json({ limit: "8mb" }));
app.use(express.raw({ limit: "8mb", type: "application/octet-stream" }));

app.post("/json", (req, res) => {
    res.json({ len: req.body.pad.length, n: req.body.n });
});

app.post("/raw", (req, res) => {
    res.json({
        len: req.body.length,
        sha: crypto.createHash("sha256").update(req.body).digest("hex").slice(0, 16)
    });
});

function post(path, body, headers = {}) {
    return fetchTest(`http://localhost:13333${path}`, { method: "POST", body, headers });
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    // small enough to arrive in a single chunk, with a content-length
    const small = JSON.stringify({ n: 1, pad: "x".repeat(4 * 1024) });
    console.log(await (await post("/json", small, { "Content-Type": "application/json" })).text());

    // large enough to arrive in several chunks, still with a content-length
    const big = JSON.stringify({ n: 2, pad: "y".repeat(512 * 1024) });
    console.log(await (await post("/json", big, { "Content-Type": "application/json" })).text());

    // past the point where the body is buffered up front, so it is collected chunk by chunk
    const huge = JSON.stringify({ n: 3, pad: "z".repeat(2 * 1024 * 1024) });
    console.log(await (await post("/json", huge, { "Content-Type": "application/json" })).text());

    // no content-length at all: the size is only known once the stream ends
    const chunked = new ReadableStream({
        start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('{"n":4,"pad":"'));
            for (let i = 0; i < 8; i++) {
                controller.enqueue(enc.encode("w".repeat(32 * 1024)));
            }
            controller.enqueue(enc.encode('"}'));
            controller.close();
        }
    });
    const chunkedResponse = await fetchTest("http://localhost:13333/json", {
        method: "POST",
        body: chunked,
        duplex: "half",
        headers: { "Content-Type": "application/json" }
    });
    console.log(await chunkedResponse.text());

    // gzipped: content-length describes the compressed size, not the parsed one
    const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify({ n: 5, pad: "q".repeat(256 * 1024) })));
    console.log(
        await (
            await post("/json", gzipped, {
                "Content-Type": "application/json",
                "Content-Encoding": "gzip"
            })
        ).text()
    );

    // binary round trip, to catch a body that is assembled at the wrong offset
    const binary = Buffer.alloc(300 * 1024);
    for (let i = 0; i < binary.length; i++) {
        binary[i] = i % 251;
    }
    console.log(await (await post("/raw", binary, { "Content-Type": "application/octet-stream" })).text());

    await new Promise((resolve) => setTimeout(resolve, 100));
    process.exit(0);
});
