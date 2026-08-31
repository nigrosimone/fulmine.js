// a body somebody already read is stepped over by the parser that runs after them
//
// body-parser asks on-finished whether the request is over before it reads, and a request that has
// been read says yes: `complete` is set once the whole body has arrived, and the stream is no
// longer readable once it has been consumed. Both halves live on the request here, and without them
// the second parser waits on a stream that will never end again and the request never answers.
//
// Three orders, because they are read differently: a reader of our own after a foreign one, a
// foreign one after ours, and ours twice. n8n reads the raw body itself for webhook signatures and
// then runs express-openapi-validator, which is the first of the three, and every POST of its
// public API hung on this.

const express = require("express");
const bodyParser = require("body-parser");
const { fetchTest, sequential } = require("../../helpers.js");

const PORT = 13351;
const app = express();
app.set("etag", false);

/** what n8n's rawBodyReader does: the whole body, read straight off the stream */
const readItFirst = (req, res, next) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
        req.rawBody = Buffer.concat(chunks);
        next();
    });
};

app.post("/foreign-reader-then-ours", readItFirst, express.json(), (req, res) =>
    res.json({ raw: String(req.rawBody), body: req.body ?? null })
);

app.post("/ours-then-foreign-parser", express.json(), bodyParser.json(), (req, res) =>
    res.json({ body: req.body ?? null })
);

app.post("/ours-twice", express.json(), express.json(), (req, res) => res.json({ body: req.body ?? null }));

// a parser that runs on its own still reads the body, which is what says the skip above is not
// simply everything being stepped over
app.post("/only-ours", express.json(), (req, res) => res.json({ body: req.body ?? null }));

app.use((err, req, res, next) => res.status(err.status || err.statusCode || 500).send("error: " + err.message));

const post = (path) => () =>
    fetchTest(`http://localhost:${PORT}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"a":"bcd"}'
    }).then((res) => res.text().then((text) => console.log(path, "->", text)));

app.listen(PORT, async () => {
    console.log("Server is running on port " + PORT);
    await sequential([
        post("/foreign-reader-then-ours"),
        post("/ours-then-foreign-parser"),
        post("/ours-twice"),
        post("/only-ours")
    ]);
    process.exit(0);
});
