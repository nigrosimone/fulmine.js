// must reject a bad body with the status and the shape body-parser gives it

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// The error handler almost every Express application has. It is the reason this matters: without a
// status on the error, a body that was merely too large or badly formed is answered 500, the client
// cannot tell a bad request from a broken server, and whatever counts 5xx counts it against the
// server. Every one of these answered 500 until 2026-08-02.
app.post("/limit", express.json({ limit: "10b" }), (req, res) => res.send("ok"));
app.post("/urlencoded-limit", express.urlencoded({ limit: "10b", extended: false }), (req, res) => res.send("ok"));
app.post("/malformed", express.json(), (req, res) => res.send("ok"));
app.post("/default", express.json(), (req, res) => res.json({ body: req.body }));
app.post("/lenient", express.json({ strict: false }), (req, res) => res.json({ body: req.body }));
app.post(
    "/verify",
    express.json({
        verify: () => {
            const err = new Error("nope");
            err.status = 403;
            throw err;
        }
    }),
    (req, res) => res.send("ok")
);

app.use((err, req, res, next) => {
    res.status(err.status || err.statusCode || 500).json({
        status: err.status ?? null,
        statusCode: err.statusCode ?? null,
        type: err.type ?? null,
        expose: err.expose ?? null,
        message: err.message
    });
});

const post = (path, body, type) =>
    fetchTest("http://localhost:13333" + path, {
        method: "POST",
        headers: { "content-type": type || "application/json" },
        body
    });

app.listen(13333, async () => {
    const cases = [
        ["/limit", JSON.stringify({ padding: "x".repeat(200) }), null],
        ["/urlencoded-limit", "a=" + "x".repeat(200), "application/x-www-form-urlencoded"],
        ["/malformed", "{ not json", null],
        ["/verify", JSON.stringify({ a: 1 }), null],

        // strict is body-parser's default, and it means an object or an array and nothing else.
        // The messages are checked too, since an application shows them: body-parser goes out of
        // its way to produce the sentence V8 would have produced.
        ["/default", '"a string"', null],
        ["/default", "123", null],
        ["/default", "true", null],
        ["/default", "null", null],

        // and what strict still accepts: only space, tab, LF and CR count as leading whitespace
        ["/default", '{"a":1}', null],
        ["/default", "[1,2]", null],
        ["/default", '  \n {"a":1}', null],
        ["/default", '\t\r\n {"a":1}', null],
        ["/default", "", null],

        // a byte order mark and a non-breaking space are not whitespace here, so they are the first
        // character and the body is refused. A wider whitespace class would quietly accept these.
        ["/default", '﻿{"a":1}', null],
        ["/default", ' {"a":1}', null],

        // turned off, a bare value is a body again
        ["/lenient", '"a string"', null],
        ["/lenient", "123", null]
    ];

    for (const [path, body, type] of cases) {
        const response = await post(path, body, type);
        console.log(path, JSON.stringify(body), await response.text());
    }

    process.exit(0);
});
