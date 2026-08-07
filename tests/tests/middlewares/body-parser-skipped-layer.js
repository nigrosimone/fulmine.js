// when a body parser may be stepped over, and when it may not
//
// A parser reached by a request that said nothing about a body answers next() at the end of a hop
// that cost ten times what its prologue did, so the chain steps over the layer instead of entering
// it. That is only sound where the parser would have done nothing observable, and the edge is
// narrow: a content-length of "0" is still something said about the body, and a parser that can see
// one answers about it, up to a 415 for a charset nobody can decode. A verb that reads bodies walks
// into the read whatever the headers say, and comes back having set req.body.
//
// The second application is the same but for `body methods`, which adds GET and DELETE to the verbs
// a body is read for. Nothing may be stepped over there, and the two halves together are what pins
// the rule rather than one example of it.

const express = require("express");
const http = require("http");

function build(port, bodyMethods) {
    const app = express();
    app.set("etag", false);
    if (bodyMethods) app.set("body methods", bodyMethods);
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.text());
    app.all("/x", (req, res) => res.json({ body: req.body ?? null }));
    app.use((err, req, res, next) => res.status(err.status || err.statusCode || 500).send("error: " + err.message));
    return app;
}

/** raw, so the headers go out exactly as written: fetch drops a content-length of its own accord */
function ask(port, method, headers, body) {
    return new Promise((resolve) => {
        const request = http.request({ host: "127.0.0.1", port, path: "/x", method, headers }, (res) => {
            let text = "";
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () => resolve(`${res.statusCode} ${text.slice(0, 70)}`));
        });
        request.on("error", (err) => resolve("failed: " + err.message));
        if (body) request.write(body);
        request.end();
    });
}

const JSON_BODY = '{"a":"bcd"}';
const FORM_BODY = "a=1&b=2";

// what decides it: what the request said about a body, and what verb it said it with
const CASES = [
    // nothing said about a body, so the parsers have nothing to do whatever the type says. This is
    // the only shape a chain may step over
    ["GET", {}, null],
    ["GET", { "content-type": "application/json" }, null],
    ["GET", { "content-type": "application/json; charset=iso-8859-15" }, null],
    ["GET", { "content-type": "text/plain" }, null],
    ["DELETE", { "content-type": "application/json" }, null],
    ["OPTIONS", { "content-type": "application/json" }, null],
    // a length of zero is still a length, and a parser that sees one answers about it
    ["GET", { "content-type": "application/json", "content-length": "0" }, null],
    ["GET", { "content-type": "application/json; charset=iso-8859-15", "content-length": "0" }, null],
    ["GET", { "content-type": "application/json; charset=utf-99", "content-length": "0" }, null],
    ["DELETE", { "content-type": "text/plain", "content-length": "0" }, null],
    // A real body on a verb that does not read one by default. Only asked of the second
    // application: this project reads bodies for POST, PUT, PATCH and QUERY unless told otherwise,
    // which the readme states as a deliberate difference, and Express parses them on any verb. What
    // is being tested here is the stepping over, so the declared difference is kept out of it
    ["GET", { "content-type": "application/json", "transfer-encoding": "chunked" }, JSON_BODY, true],
    ["GET", { "content-type": "application/json", "content-length": String(JSON_BODY.length) }, JSON_BODY, true],
    ["DELETE", { "content-type": "application/json", "content-length": String(JSON_BODY.length) }, JSON_BODY, true],
    ["POST", { "content-type": "application/json" }, null],
    ["POST", { "content-type": "application/json", "content-length": String(JSON_BODY.length) }, JSON_BODY],
    [
        "PUT",
        { "content-type": "application/x-www-form-urlencoded", "content-length": String(FORM_BODY.length) },
        FORM_BODY
    ],
    ["PATCH", { "content-type": "text/plain", "content-length": "5" }, "plain"],
    ["POST", { "content-type": "text/plain" }, null]
];

const withDefaults = build(13333, null);
const withMoreVerbs = build(13334, ["POST", "PUT", "PATCH", "QUERY", "GET", "DELETE"]);

withDefaults.listen(13333, () => {
    withMoreVerbs.listen(13334, async () => {
        console.log("Server is running on port 13333");

        for (const [label, port, readsEveryVerb] of [
            ["the default verbs", 13333, false],
            ["GET and DELETE reading bodies too", 13334, true]
        ]) {
            console.log(`\n--- ${label} ---`);
            for (const [method, headers, body, needsEveryVerb] of CASES) {
                if (needsEveryVerb && !readsEveryVerb) continue;
                const answer = await ask(port, method, headers, body);
                console.log(
                    method,
                    JSON.stringify(headers),
                    body === null ? "no body" : `body ${body.length}`,
                    "->",
                    answer
                );
            }
        }

        process.exit(0);
    });
});
