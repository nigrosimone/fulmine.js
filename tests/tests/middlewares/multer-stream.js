// what multer is handed, on the shapes that exercise the stream underneath it rather than the parser
// INSPECT
//
// The parsing is multer's and identical on both servers. What differs is what feeds it: a body
// that arrives in more than one chunk, one that arrives without a content-length, one that stops
// halfway, and one that trips a limit and turns into an error mid-stream. The existing multer test
// covers a field and a small file; these are the ones where our own body path is the variable.

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const multer = require("multer");
const crypto = require("crypto");

const app = express();

// contents that are the same on both runs and long enough to cross a chunk
const big = Buffer.alloc(300 * 1024, "abcdefgh");
const digest = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

/** What a file looks like once the buffer itself is replaced by its length and digest. */
const describeFile = (file) => ({
    field: file.fieldname,
    name: file.originalname,
    type: file.mimetype,
    size: file.size,
    sha: digest(file.buffer)
});

app.post("/one", multer().single("file"), (req, res) => {
    res.json({ body: req.body, file: req.file ? describeFile(req.file) : null });
});

app.post("/many", multer().array("files", 4), (req, res) => {
    res.json({ body: req.body, files: (req.files || []).map(describeFile) });
});

app.post("/any", multer().any(), (req, res) => {
    res.json({ body: req.body, files: (req.files || []).map(describeFile) });
});

// a limit multer enforces while the body is still arriving
app.post("/small", multer({ limits: { fileSize: 1024 } }).single("file"), (req, res) => {
    res.json({ file: req.file ? describeFile(req.file) : null });
});

app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ error: err.message, code: err.code || null });
});

/** A multipart body written by hand, so the boundary and the order are the same on both runs. */
function multipart(parts, boundary) {
    const chunks = [];
    for (const part of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        if (part.filename !== undefined) {
            chunks.push(
                Buffer.from(
                    `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
                        `Content-Type: ${part.type || "text/plain"}\r\n\r\n`
                )
            );
        } else {
            chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
        }
        chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value)));
        chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(chunks);
}

const BOUNDARY = "----fulmineTestBoundary";
const type = { "content-type": `multipart/form-data; boundary=${BOUNDARY}` };

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const single = multipart(
        [{ name: "file", filename: "big.bin", type: "application/octet-stream", value: big }],
        BOUNDARY
    );
    const several = multipart(
        [
            { name: "note", value: "a plain field" },
            { name: "files", filename: "one.txt", value: "first" },
            { name: "files", filename: "two.txt", value: big },
            { name: "files", filename: "tré.txt", value: "unicode in the name" }
        ],
        BOUNDARY
    );

    // a body long enough to arrive in more than one chunk
    const one = await fetchTest("http://localhost:13333/one", { method: "POST", headers: type, body: single });
    console.log("one", one.status, await one.text());

    // several files and a field, one of them large and one with a unicode filename
    const many = await fetchTest("http://localhost:13333/many", { method: "POST", headers: type, body: several });
    console.log("many", many.status, await many.text());

    const any = await fetchTest("http://localhost:13333/any", { method: "POST", headers: type, body: several });
    console.log("any", any.status, await any.text());

    // a file past the limit, which multer stops mid-stream
    const small = await fetchTest("http://localhost:13333/small", { method: "POST", headers: type, body: single });
    console.log("small", small.status, await small.text());

    // a body that stops in the middle of a part, with the content-length still promising the rest
    const truncated = single.subarray(0, single.length - 120);
    const cut = await fetchTest("http://localhost:13333/one", {
        method: "POST",
        headers: { ...type, "content-length": String(single.length) },
        body: truncated
    }).catch((err) => ({ status: "fetch failed", text: async () => String(err.name) }));
    console.log("truncated", cut.status, await cut.text());

    // and one with no content-length at all, which arrives chunked
    const streamed = await fetchTest("http://localhost:13333/one", {
        method: "POST",
        headers: type,
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(single.subarray(0, 1000));
                controller.enqueue(single.subarray(1000));
                controller.close();
            }
        }),
        duplex: "half"
    });
    console.log("chunked", streamed.status, await streamed.text());

    process.exit(0);
});
