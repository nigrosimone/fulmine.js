// What listen() decides about each route, and how to hold it to that from a test.
//
// A route stays on the fast path only while it stays eligible, and nothing complains when it
// stops: the answer is still correct, only slower, and the commit that did it is found weeks
// later. express.testing is the half a test can assert on.
//
//   node fast-routes.js
//   npx fulmine.js profile fast-routes.js   # the same verdicts, for a human to read
const express = require("fulmine.js"); // instead of require("express")
const { expectNative, expectDeclarative, routeReport, expectLazy } = require("fulmine.js").testing;

const app = express();

// a response that would carry an ETag is never compiled: uWS answers it without reading the
// request, so it could not turn a conditional request into a 304. This setting is what puts an
// ordinary route on the compiled path, and nothing below would be compiled without it
app.set("etag", false);

// literal arguments and nothing in front of it: compiled into a response written once, at
// startup, and answered by uWS without entering JavaScript at all
app.get("/health", (req, res) => res.json({ ok: true }));

// a parameter that is a whole segment: matched by uWS in C++, and the layers in front of it are
// worked out at listen() rather than tested per request
app.get("/api/items/:id", (req, res) => res.json({ id: req.params.id, at: Date.now() }));

// this one cannot be native: the parameter is not a whole segment, so it goes the ordinary way
app.get("/flights/:from-:to", (req, res) => res.json(req.params));

// The route verdict holds for every request. The other half holds for one: a native route still
// folds req.headers into an object if something reads it, still turns the response into a
// Writable if something writes it in pieces, and the answer stays correct either way. expectLazy
// throws when this request built anything allow does not name
app.get("/api/search", (req, res) => {
    const found = { q: req.query.q };
    expectLazy(req, res, { allow: ["query"] });
    res.json(found);
});

app.listen(3000, () => {
    // throws, naming the route and the reason, if either of these stopped being eligible. A
    // pattern that matches no route throws too, so a misspelled path fails instead of passing
    // quietly. A trailing * names everything under a prefix
    expectNative(app, ["GET /health", "/api/*"]);

    // the step past native: no javascript at all
    expectDeclarative(app, "/health");

    // the whole list, to assert on however you like
    for (const route of routeReport(app)) {
        const how = route.declarative ? "declarative" : route.native ? "native" : `router: ${route.reason}`;
        console.log(`${route.method.padEnd(6)} ${route.path.padEnd(20)} ${how}`);
    }

    // the application does not need to be listening for any of this: the verdicts are settled by
    // the same half of listen() that npx fulmine.js profile runs, which binds no port
});
