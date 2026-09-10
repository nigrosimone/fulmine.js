// an empty body under a Content-Encoding: the encoding is judged before the empty body becomes
// the parser's empty value, so one nobody can inflate answers 415, one zlib refuses to end
// answers 400, and with inflate off every encoding but identity answers 415

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.post("/on", express.json(), (req, res) => res.json(req.body));
app.post("/off", express.json({ inflate: false }), (req, res) => res.json(req.body));
// a request wrong in both ways: which of the two is named is the parser's own order
app.post("/both", express.json(), (req, res) => res.json(req.body));
app.post("/text", express.text(), (req, res) => res.json(req.body));
app.use((err, req, res, next) =>
    res
        .status(err.status)
        .type("txt")
        .send(`${err.type ?? "no type"}: ${err.message}`)
);

const cases = [];
for (const path of ["/on", "/off"]) {
    for (const encoding of ["identity", "gzip", "deflate", "br", "zstd"]) {
        cases.push(async () => {
            const res = await fetchTest("http://localhost:13333" + path, {
                method: "POST",
                headers: { "content-type": "application/json", "content-encoding": encoding },
                body: Buffer.alloc(0)
            });
            console.log(path, encoding, res.status, await res.text());
        });
    }
}

// Both wrong at once, empty and not. Which one is named depends on the parser: json refuses a
// charset that is not utf-* before it looks at the encoding, text has no such rule and only asks
// iconv, which happens after.
for (const body of [Buffer.alloc(0), Buffer.from("{}")]) {
    for (const [path, type] of [
        ["/both", "application/json; charset=nonsense"],
        ["/text", "text/plain; charset=nonsense"]
    ]) {
        cases.push(async () => {
            const res = await fetchTest("http://localhost:13333" + path, {
                method: "POST",
                headers: { "content-type": type, "content-encoding": "zstd" },
                body
            });
            console.log(path, body.length, res.status, await res.text());
        });
    }
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(cases);
    process.exit(0);
});
