// must strip the entity headers from a response that carries no body

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// 204, 205 and 304 are the three statuses whose framing differs from every other one: the first
// two may carry no body at all, and the third answers a conditional request.
app.get("/204", (req, res) => res.status(204).type("html").send("ignored"));
app.get("/205", (req, res) => res.status(205).type("html").send("ignored"));
app.get("/304", (req, res) => res.status(304).type("html").send("ignored"));

// The same three set through end() rather than send()
app.get("/204-end", (req, res) => res.status(204).type("html").end("ignored"));
app.get("/205-end", (req, res) => res.status(205).type("html").end("ignored"));

// Reached with a matching If-None-Match, so req.fresh is true and send() answers 304 by itself.
// The body is built rather than written literally so the handler cannot be compiled into a
// declarative response, which is answered natively and cannot say 304 at all. That divergence has
// its own test: tests/tests/res/res-declarative-conditional.js.
app.get("/fresh", (req, res) => {
    res.set("ETag", '"abc"');
    res.send(["b", "o", "d", "y"].join(""));
});

// end() is node's, and node knows nothing about freshness: a matching If-None-Match still gets
// the body and a 200
app.get("/fresh-end", (req, res) => {
    res.set("ETag", '"abc"');
    res.end(["b", "o", "d", "y"].join(""));
});

app.listen(13333, async () => {
    // max-age is not decoration: fetch adds "cache-control: no-cache" of its own whenever the
    // request carries a conditional header, and that alone makes req.fresh false. Setting the
    // header explicitly replaces it, so the conditional request can actually be fresh.
    const matching = { headers: { "if-none-match": '"abc"', "cache-control": "max-age=604800" } };
    const responses = await Promise.all([
        fetchTest("http://localhost:13333/204"),
        fetchTest("http://localhost:13333/205"),
        fetchTest("http://localhost:13333/304"),
        fetchTest("http://localhost:13333/204-end"),
        fetchTest("http://localhost:13333/205-end"),
        fetchTest("http://localhost:13333/fresh", matching),
        fetchTest("http://localhost:13333/fresh-end", matching)
    ]);

    for (const response of responses) {
        const body = await response.text();
        console.log(new URL(response.url).pathname, response.status, JSON.stringify(body));
    }

    process.exit(0);
});
