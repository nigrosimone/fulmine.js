// a body compression does not take keeps the encoding res.end() was given

const express = require("express");
const compression = express.compression || require("compression");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);
app.use(compression());

// under the threshold, and a type the filter refuses
app.get("/small", (req, res) => {
    res.type("text/plain");
    res.end("6869", "hex");
});
app.get("/image", (req, res) => {
    res.type("image/png");
    res.end("aGk=", "base64");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/small", "/image"]) {
        const res = await fetchTest("http://localhost:13333" + path, { headers: { "accept-encoding": "gzip" } });
        console.log(path, res.status, res.headers.get("content-encoding"), await res.text());
    }

    process.exit(0);
});
