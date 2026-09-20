// A limit option the parser cannot read: body-parser 2.3 refuses it when the parser is built,
// where before it silently stopped enforcing any limit (CVE-2026-12590). null means the default

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

for (const limit of ["abc", "", {}, -1, "10 elephants"]) {
    for (const parser of ["json", "urlencoded", "raw", "text"]) {
        try {
            express[parser]({ limit });
            console.log(parser, JSON.stringify(limit), "accepted");
        } catch (err) {
            console.log(parser, JSON.stringify(limit), err.constructor.name, err.message);
        }
    }
}

const app = express();
app.post("/null", express.json({ limit: null }), (req, res) => res.send("ok"));
app.post("/undefined", express.json({ limit: undefined }), (req, res) => res.send("ok"));
app.post("/number", express.json({ limit: 10 }), (req, res) => res.send("ok"));
app.use((err, req, res, next) => res.status(err.status || 500).send(`${err.type}: ${err.message}`));

app.listen(13333, async () => {
    const big = JSON.stringify({ padding: "x".repeat(200 * 1024) });
    const small = JSON.stringify({ a: 1 });
    await sequential(
        [
            ["/null", big],
            ["/null", small],
            ["/undefined", big],
            ["/number", big],
            ["/number", small]
        ].map(([path, body]) => async () => {
            const res = await fetchTest("http://localhost:13333" + path, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body
            });
            console.log(path, body.length, await res.text());
        })
    );
    process.exit(0);
});
