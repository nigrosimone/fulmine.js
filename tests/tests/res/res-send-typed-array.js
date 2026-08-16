// res.send() of a typed array is bytes, and an etag function is allowed to decline
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag fn", (body) => (String(body).includes("skip") ? undefined : `"len-${String(body).length}"`));

app.get("/uint8", (req, res) => {
    res.send(new Uint8Array([104, 101, 121]));
});

app.get("/slice", (req, res) => {
    // a view over part of a buffer sends that part, not the whole buffer behind it
    const bytes = new Uint8Array([0, 0, 104, 101, 121]);
    res.send(bytes.subarray(2));
});

// nothing back from the etag function means no header, rather than a header reading "undefined"
app.get("/no-etag", (req, res) => res.send("skip this one"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/uint8", "/slice", "/no-etag"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, JSON.stringify(res.headers.get("etag")), await res.text());
    }

    process.exit(0);
});
