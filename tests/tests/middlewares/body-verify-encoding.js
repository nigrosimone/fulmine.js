// must hand the verify hook the charset as its fourth argument, as body-parser does: a hook that
// checks a signature over the decoded text needs it, and raw is handed null

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

const verify = (req, res, buf, encoding) => {
    console.log("verify", req.path, buf.length, JSON.stringify(encoding));
};

app.post("/json", express.json({ verify }), (req, res) => res.json(req.body));
app.post("/text", express.text({ verify }), (req, res) => res.send(req.body));
app.post("/urlencoded", express.urlencoded({ verify, extended: false }), (req, res) => res.json(req.body));
app.post("/raw", express.raw({ verify }), (req, res) => res.send(req.body));

const post = (path, body, type) =>
    fetchTest("http://localhost:13333" + path, {
        method: "POST",
        headers: { "content-type": type },
        body
    });

app.listen(13333, async () => {
    for (const [path, body, type] of [
        ["/json", '{"a":1}', "application/json"],
        ["/json", '{"a":1}', "application/json; charset=UTF-8"],
        ["/text", "ciao", "text/plain"],
        ["/text", "ciao", "text/plain; charset=ISO-8859-1"],
        ["/urlencoded", "a=1", "application/x-www-form-urlencoded"],
        ["/raw", "bytes", "application/octet-stream"],
        // an empty body runs the hook too, and it is handed the charset all the same
        ["/json", "", "application/json"]
    ]) {
        const response = await post(path, body, type);
        console.log(path, type, response.status, await response.text());
    }

    process.exit(0);
});
