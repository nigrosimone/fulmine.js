// a gzip body cut short must answer 400, not parse whatever bytes came out
// INSPECT

const express = require("express");
const zlib = require("zlib");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.use(express.raw());
app.use(express.text());
app.use(express.urlencoded({ extended: false }));
app.post("/", (req, res) => {
    res.json({ body: Buffer.isBuffer(req.body) ? req.body.toString("hex") : req.body });
});
app.use((err, req, res, next) => res.status(err.status || 500).send(`${err.status}`));

const good = zlib.gzipSync(Buffer.from("name=tobi"));
// the trailer carries the crc and length; losing its last byte leaves the data intact but the
// stream incomplete
const truncated = good.subarray(0, good.length - 1);

/**
 * One POST with a gzip body under the given content-type.
 *
 * @param {string} type
 * @param {Buffer} body
 * @returns {Promise<Response>}
 */
function post(type, body) {
    return fetchTest("http://localhost:13333/", {
        method: "POST",
        headers: { "content-type": type, "content-encoding": "gzip" },
        body
    });
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const type of ["application/octet-stream", "text/plain", "application/x-www-form-urlencoded"]) {
        const ok = await post(type, good);
        console.log(type, "good", ok.status, await ok.text());

        const bad = await post(type, truncated);
        console.log(type, "truncated", bad.status, await bad.text());
    }

    process.exit(0);
});
