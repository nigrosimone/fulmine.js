// must match the content-type case-insensitively and past legal whitespace, as type-is does:
// INSPECT
// media types are case-insensitive per RFC 2045, and OWS may precede the ";"

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.post("/json", express.json(), (req, res) => res.json({ body: req.body ?? null }));
// the caller's side of the comparison is normalized too
app.post("/upper-type", express.json({ type: "Application/JSON" }), (req, res) => res.json({ body: req.body ?? null }));

const post = (route, type) =>
    fetchTest("http://localhost:13333" + route, {
        method: "POST",
        headers: { "content-type": type },
        body: '{"a":"b"}'
    });

app.listen(13333, async () => {
    const cases = [
        ["/json", "application/json"],
        ["/json", "Application/JSON"],
        ["/json", "APPLICATION/JSON; charset=utf-8"],
        ["/json", "application/json ; charset=utf-8"],
        // and what still has to fall through unclaimed
        ["/json", "application/jsonx"],
        ["/upper-type", "application/json"]
    ];

    for (const [route, type] of cases) {
        const response = await post(route, type);
        console.log(route, type, response.status, await response.text());
    }

    process.exit(0);
});
