// must run the verify hook for an empty body too: body-parser verifies before parsing, empty
// INSPECT
// included, and webhook signature checks rely on being able to refuse a bodyless request

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.post(
    "/reject",
    express.json({
        verify: () => {
            throw new Error("nope");
        }
    }),
    (req, res) => res.json({ body: req.body ?? null })
);

app.post(
    "/inspect",
    express.json({
        verify: (req, res, buf) => {
            console.log("verify ran, buf length", buf.length);
        }
    }),
    (req, res) => res.json({ body: req.body ?? null })
);

app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({
        err: err.message,
        type: err.type ?? null,
        status: err.status ?? null
    });
});

const post = (route, body) =>
    fetchTest("http://localhost:13333" + route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
    });

app.listen(13333, async () => {
    for (const [route, body] of [
        ["/reject", ""],
        ["/reject", '{"a":1}'],
        ["/inspect", ""],
        ["/inspect", '{"a":1}']
    ]) {
        const response = await post(route, body);
        console.log(route, JSON.stringify(body), response.status, await response.text());
    }

    process.exit(0);
});
