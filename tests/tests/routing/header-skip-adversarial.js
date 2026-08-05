// Adversarial probes for the registration-time usage analysis. With etag off, fulmine grants
// analyzed GET chains the right to skip the header copy and the query fetch; Express has no
// such machinery, so every byte here must come out identical on both, or the analysis lied.
// Each request deliberately CARRIES the things a wrong skip would lose: a probe header, the
// conditional trio, a query string, a Connection preference.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// the shape the skip exists for: reads nothing but path, asked with everything present
app.get("/plain", (req, res) => {
    res.send("plain " + req.path);
});

// reads a header the obvious way: the analysis must refuse and the echo must work
app.get("/get-header", (req, res) => {
    res.send(req.get("x-probe") || "none");
});

// reads a header through an alias the walk cannot follow: refusal is the only sound answer
app.get("/alias", (req, res) => {
    const readIt = (r) => r.get("x-probe");
    res.send(readIt(req) || "none");
});

// specific keys off the headers object
app.get("/keys", (req, res) => {
    res.json({ probe: req.headers["x-probe"], hasUa: typeof req.headers["user-agent"] === "string" });
});

// a middleware that rewrites req.url re-enters routing: the target must still see headers
app.get(
    "/rewrite",
    (req, res, next) => {
        req.url = "/rewrite-target";
        next();
    },
    (req, res) => res.send("never reached")
);
app.get("/rewrite-target", (req, res) => {
    res.send("target saw " + (req.get("x-probe") || "none"));
});

// a hand-set validator: freshness must compare it against If-None-Match even with etag off
app.get("/manual-etag", (req, res) => {
    res.set("ETag", '"manual-tag"');
    res.send("tagged body");
});

// next("route") escapes to a later route that reads headers
app.get("/dup", (req, res, next) => next("route"));
app.get("/dup", (req, res) => {
    res.send("second saw " + (req.get("x-probe") || "none"));
});

// query read on one route, none on its twin: both asked with a query string attached
app.get("/query-read", (req, res) => {
    res.send("q=" + (req.query.q || "none"));
});
app.get("/query-blind", (req, res) => {
    res.send("blind");
});

// a parameterised route inside a mounted router, the holder-carried skip
const api = express.Router();
api.get("/users/:id/posts", (req, res) => {
    res.json({ user: req.params.id, limit: req.query.limit || null });
});
app.use("/api", api);

app.listen(13457, async () => {
    console.log("Server is running on port 13457");

    const noisyHeaders = {
        "x-probe": "PRESENT",
        accept: "application/json, text/plain;q=0.8",
        "accept-language": "en-GB,en;q=0.9",
        cookie: "session=abc; theme=dark",
        "cache-control": "no-cache",
        "user-agent": "adversarial-suite/1.0"
    };

    const cases = [
        ["/plain", {}],
        ["/plain", { headers: noisyHeaders }],
        ["/plain?a=1&b=2", { headers: noisyHeaders }],
        ["/plain", { method: "HEAD", headers: noisyHeaders }],
        ["/plain", { headers: { ...noisyHeaders, "if-none-match": '"whatever"' } }],
        ["/plain", { headers: { ...noisyHeaders, "if-none-match": "*" } }],
        ["/plain", { headers: { ...noisyHeaders, "if-modified-since": "Sat, 01 Jan 2028 00:00:00 GMT" } }],
        ["/get-header", { headers: noisyHeaders }],
        ["/get-header", {}],
        ["/alias", { headers: noisyHeaders }],
        ["/keys", { headers: noisyHeaders }],
        ["/rewrite", { headers: noisyHeaders }],
        ["/manual-etag", { headers: { "if-none-match": '"manual-tag"' } }],
        ["/manual-etag", { headers: { "if-none-match": '"other-tag"' } }],
        ["/manual-etag", { headers: { "if-none-match": '"manual-tag"', "cache-control": "no-cache" } }],
        ["/dup", { headers: noisyHeaders }],
        ["/query-read?q=hello&r=2", { headers: noisyHeaders }],
        ["/query-read", {}],
        ["/query-blind?q=ignored&x=9", { headers: noisyHeaders }],
        ["/api/users/42/posts?limit=10", { headers: noisyHeaders }],
        ["/api/users/7/posts", {}],
        // the framework's own 404 for a fall-through, asked with everything present
        ["/absent", { headers: { ...noisyHeaders, "if-none-match": "*" } }]
    ];

    for (const [path, init] of cases) {
        const res = await fetchTest(`http://localhost:13457${path}`, init);
        console.log(
            init.method || "GET",
            path,
            res.status,
            JSON.stringify(init.headers ? Object.keys(init.headers).length : 0),
            JSON.stringify(await res.text())
        );
    }

    // flipping etags back on after listen revokes every skip: the manual validator keeps
    // working and /plain now earns a generated etag, which the harness compares by value
    app.set("etag", true);
    for (const [path, init] of [
        ["/plain", { headers: noisyHeaders }],
        ["/manual-etag", { headers: { "if-none-match": '"manual-tag"' } }]
    ]) {
        const res = await fetchTest(`http://localhost:13457${path}`, init);
        console.log("after-etag", path, res.status, JSON.stringify(await res.text()));
    }

    process.exit(0);
});
