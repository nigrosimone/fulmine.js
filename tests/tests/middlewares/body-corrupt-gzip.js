// a body that will not decompress is answered, and the server is still there afterwards

const express = require("express");
const zlib = require("zlib");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.use(express.json());
app.post("/", (req, res) => res.json(req.body));
app.get("/alive", (req, res) => res.send("alive"));
app.use((err, req, res, next) => res.status(err.status || 500).send(`${err.status}`));

const good = zlib.gzipSync(Buffer.from(JSON.stringify({ a: 1 })));
// the last byte is part of the crc, so this decompresses to the right bytes and then fails the check
const corrupt = Buffer.from(good);
corrupt[corrupt.length - 1] ^= 0xff;

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const ok = await fetchTest("http://localhost:13333/", {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: good
    });
    console.log("gzip", ok.status, await ok.text());

    const bad = await fetchTest("http://localhost:13333/", {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: corrupt
    });
    console.log("corrupt", bad.status, await bad.text());

    // zlib reports the failure twice, and the second one used to end the process
    const after = await fetchTest("http://localhost:13333/alive");
    console.log("after", after.status, await after.text());

    process.exit(0);
});
