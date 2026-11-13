// res.set() and res.header() with one argument
//
// Express reads one argument as an object of headers, so undefined sets nothing. express-zod-api
// calls res.set(error.headers) on every error, and here it threw: each error answered 500.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();

app.get("/set-undefined", (req, res) => {
    res.set(undefined).status(404).json({ message: "not found" });
});
app.get("/header-undefined", (req, res) => {
    res.header(undefined).status(400).send("bad");
});
app.get("/set-null", (req, res) => {
    res.set(null).send("null");
});
app.get("/header-object", (req, res) => {
    res.header({ "x-one": "1", "x-two": "2" }).send("object");
});
// the message, not the stack: the frames differ between the two
app.use((err, req, res, next) => res.status(500).send(err.message));

app.listen(13764, async () => {
    const outputs = await sequential(
        ["/set-undefined", "/header-undefined", "/set-null", "/header-object"].map((path) => async () => {
            const res = await fetchTest(`http://localhost:13764${path}`);
            return `${path} ${res.status} ${res.headers.get("x-one")} ${res.headers.get("x-two")} ${await res.text()}`;
        })
    );
    console.log(outputs.join("\n"));
    process.exit(0);
});
