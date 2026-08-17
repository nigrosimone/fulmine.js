// whether req.body is on the request at all, which is a different question from what it holds
//
// body-parser puts the property there before it decides anything, and leaves it undefined on a
// request it goes on to skip. Libraries read `"body" in req` to tell "a parser has run" from "none
// has", and the two popular ones read it in opposite directions: Apollo's express middleware
// answers 500 when the property is missing, and tRPC's express adapter reads the body off the
// stream itself when it is, so a request carrying it by default loses every tRPC mutation.
//
// The last application is the one that pins the stepped-over layer: a GET that says nothing about a
// body never enters the parser here, and the skip still has to leave what the parser would have.

const express = require("express");

/** What a handler can see about the property, without printing a body that differs by case. */
function report(req) {
    return {
        present: "body" in req,
        own: Object.prototype.hasOwnProperty.call(req, "body"),
        type: req.body === undefined ? "undefined" : Array.isArray(req.body) ? "array" : typeof req.body,
        value: req.body === undefined ? null : req.body
    };
}

// no parser anywhere: nothing has claimed the request, so nothing has put the property there
const bare = express();
bare.set("etag", false);
bare.all("/x", (req, res) => res.json(report(req)));

// the usual front: json first, urlencoded after it
const parsed = express();
parsed.set("etag", false);
parsed.use(express.json());
parsed.use(express.urlencoded({ extended: true }));
parsed.all("/x", (req, res) => res.json(report(req)));

// something wrote a body before the parser was reached, which body-parser leaves alone
const preset = express();
preset.set("etag", false);
preset.use((req, res, next) => {
    req.body = { mine: true };
    next();
});
preset.use(express.json());
preset.all("/x", (req, res) => res.json(report(req)));

const JSON_BODY = '{"a":1}';
const FORM_BODY = "a=1";

/** @param {number} port @param {string} label */
async function ask(port, label, init) {
    const response = await fetch(`http://localhost:${port}/x`, init);
    console.log(label, response.status, JSON.stringify(await response.json()));
}

bare.listen(13333, () => {
    parsed.listen(13334, () => {
        preset.listen(13335, async () => {
            console.log("Server is running on port 13333");

            for (const [name, port] of [
                ["no parser", 13333],
                ["json then urlencoded", 13334],
                ["a body set before the parser", 13335]
            ]) {
                console.log(`\n--- ${name} ---`);
                // a GET that says nothing about a body: the layer may be stepped over entirely
                await ask(port, "GET", {});
                // a GET that names a type but still carries nothing
                await ask(port, "GET typed", { headers: { "content-type": "application/json" } });
                // a POST the parser claims
                await ask(port, "POST json", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON_BODY
                });
                // a POST with a type neither parser wants, so both skip after seeding
                await ask(port, "POST text", {
                    method: "POST",
                    headers: { "content-type": "text/plain" },
                    body: "hello"
                });
                // the second parser's turn, so the first one has already seeded and skipped
                await ask(port, "POST form", {
                    method: "POST",
                    headers: { "content-type": "application/x-www-form-urlencoded" },
                    body: FORM_BODY
                });
                // a POST with a body and no type at all
                await ask(port, "POST untyped", { method: "POST", body: "hello" });
            }

            process.exit(0);
        });
    });
});
