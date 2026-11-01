// a compiled body says what javascript says: + adds before it concatenates, end() takes no boolean
//
// The compiler joined every operand of + as text, so 1 + 2 + " items" answered "12 items", and it
// wrote end(true) and end(false) as text where node throws on the first and writes nothing for the
// second.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("env", "production");
app.set("etag", false);
app.get("/sum-first", (req, res) => res.end(1 + 2 + " items"));
app.get("/text-first", (req, res) => res.end("n" + 1 + 2));
app.get("/sum-send", (req, res) => res.send(1 + 2 + " items"));
app.get("/null-sum", (req, res) => res.end(null + 1 + "x"));
app.get("/end-true", (req, res) => res.end(true));
app.get("/end-false", (req, res) => res.end(false));
app.get("/send-true", (req, res) => res.send(true));
app.use((err, req, res, next) => res.status(500).send("error " + err.code));

app.listen(13333, async () => {
    if (express.testing) express.testing.expectDeclarative(app, ["/text-first", "/send-true"]);
    const paths = ["/sum-first", "/text-first", "/sum-send", "/null-sum", "/end-true", "/end-false", "/send-true"];
    await sequential(
        paths.map((path) => async () => {
            const res = await fetchTest("http://localhost:13333" + path);
            console.log(path, res.status, JSON.stringify(await res.text()));
        })
    );
    process.exit(0);
});
