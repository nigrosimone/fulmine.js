// must answer a conditional request the same way on a route whose chain skips the header copy

// The header copy is skipped when the chain provably reads no header, and that used to require
// etag off as well. It does not: send consults freshness whatever the setting, and the skip branch
// reads the conditional trio by name for exactly that reason. Every shape freshness can take is
// here, because the skip is what would silently break them.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();

// etag is left at its default, which is the point: this route's chain reads no header, so it is a
// skip candidate, and everything below is answered from headers the skip branch read by name
app.get("/body", (req, res) => {
    res.send("hello world");
});
app.get("/dated", (req, res) => {
    res.set("Last-Modified", "Wed, 21 Oct 2015 07:28:00 GMT");
    res.send("dated body");
});

const PORT = 13333;

app.listen(PORT, async () => {
    // the tag this server computed for the body, which is what a client would send back
    const first = await fetchTest(`http://localhost:${PORT}/body`);
    const etag = first.headers.get("etag");
    console.log("body etag present:", typeof etag === "string" && etag.length > 0);
    await first.text();

    // max-age is not decoration: fetch adds "cache-control: no-cache" of its own whenever the
    // request carries a conditional header, and that alone makes req.fresh false
    const fresh = { "cache-control": "max-age=604800" };

    const answers = await sequential([
        // the exact tag, which is the ordinary revalidation
        () => fetchTest(`http://localhost:${PORT}/body`, { headers: { ...fresh, "if-none-match": etag } }),
        // star matches anything that exists
        () => fetchTest(`http://localhost:${PORT}/body`, { headers: { ...fresh, "if-none-match": "*" } }),
        // a tag that is not this one
        () => fetchTest(`http://localhost:${PORT}/body`, { headers: { ...fresh, "if-none-match": '"nope"' } }),
        // no-cache from the client refuses the cached copy, so the body comes back
        () =>
            fetchTest(`http://localhost:${PORT}/body`, {
                headers: { "cache-control": "no-cache", "if-none-match": etag }
            }),
        // the HEAD twin of the same registration
        () =>
            fetchTest(`http://localhost:${PORT}/body`, {
                method: "HEAD",
                headers: { ...fresh, "if-none-match": etag }
            }),
        // if-modified-since against a Last-Modified the handler set itself
        () =>
            fetchTest(`http://localhost:${PORT}/dated`, {
                headers: { ...fresh, "if-modified-since": "Wed, 21 Oct 2015 07:28:00 GMT" }
            }),
        // older than the body, so it is not fresh
        () =>
            fetchTest(`http://localhost:${PORT}/dated`, {
                headers: { ...fresh, "if-modified-since": "Tue, 20 Oct 2015 07:28:00 GMT" }
            })
    ]);

    const labels = ["exact tag", "star", "wrong tag", "no-cache", "head twin", "modified-since", "older-since"];
    for (let i = 0; i < answers.length; i++) {
        console.log(labels[i], answers[i].status, JSON.stringify(await answers[i].text()));
    }

    process.exit(0);
});
