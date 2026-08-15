// must answer a conditional request the same way whichever path serves it

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();

// Same route twice, and neither is compiled into a declarative response. uWS writes those natively
// and has no way to branch on the request, so a response that would carry a validator is left on
// the ordinary path, which can answer 304. This used to compile the first one, write the ETag it
// was given, and then answer 200 with the whole body to every revalidation, forever.
app.get("/first", (req, res) => {
    res.set("ETag", '"abc"');
    res.send("body");
});
app.get("/second", (req, res) => {
    res.set("ETag", '"abc"');
    res.send(["b", "o", "d", "y"].join(""));
});

app.listen(13333, async () => {
    // max-age is not decoration: fetch adds "cache-control: no-cache" of its own whenever the
    // request carries a conditional header, and that alone makes req.fresh false.
    const matching = { headers: { "if-none-match": '"abc"', "cache-control": "max-age=604800" } };

    const [first, second] = await sequential([
        () => fetchTest("http://localhost:13333/first", matching),
        () => fetchTest("http://localhost:13333/second", matching)
    ]);

    console.log("first answers 304:", first.status === 304 && (await first.text()) === "");
    console.log("second answers 304:", second.status === 304 && (await second.text()) === "");

    process.exit(0);
});
