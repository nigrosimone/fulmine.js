// res.send() of a bigint or a regex literal, which the compiler must leave to the ordinary path
//
// Express throws on a bigint (Buffer.from refuses it) and sends a regex as JSON, "{}". The compiled
// path wrote both as text, a 200 with "1". Found by tools/fuzz.js --self, replay with
// --seed 3653117511 --rounds 1.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
// no etag, so a literal body would be compiled
app.set("etag", false);

app.get("/bigint", (req, res) => {
    res.send(1n);
});
app.get("/regex", (req, res) => {
    res.send(/a+b/g);
});
app.get("/text", (req, res) => {
    res.send("still compiled");
});
// the message, not the stack: the frames differ between the two
app.use((err, req, res, next) => res.status(500).send(err.code));

app.listen(13335, async () => {
    if (express.testing) express.testing.expectDeclarative(app, "/text");

    const outputs = await sequential(
        ["/bigint", "/regex", "/text"].map((path) => async () => {
            const res = await fetchTest(`http://localhost:13335${path}`);
            return `${path} ${res.status} ${await res.text()}`;
        })
    );
    console.log(outputs.join("\n"));
    process.exit(0);
});
