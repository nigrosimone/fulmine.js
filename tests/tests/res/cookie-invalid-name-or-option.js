// what an invalid cookie name, path or domain throws
//
// The cookie package writes that message, and its 1.x wording puts the offending value at the end
// of it where the 0.7 express depends on does not. Being on the newer one made every one of these
// read differently from express, for input both refuse either way.
// Found by sweeping hostile values through the response API, tools/header-fuzz.js.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

app.get("/name", (req, res) => res.cookie(String(req.query.v), "x").end("ok"));
app.get("/clear", (req, res) => res.clearCookie(String(req.query.v)).end("ok"));
app.get("/path", (req, res) => res.cookie("k", "x", { path: String(req.query.v) }).end("ok"));
app.get("/domain", (req, res) => res.cookie("k", "x", { domain: String(req.query.v) }).end("ok"));

// express's own page prints its own frames, which can never match
app.use((err, req, res, next) => res.status(500).type("txt").send(err.message));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const [route, value] of [
        ["name", "a b"],
        ["name", "a\r\nX-Injected: yes"],
        ["name", ""],
        ["clear", "a b"],
        ["path", "a\rb"],
        ["domain", "a b"],
        // and the ones that are fine, so the header they write is compared too
        ["name", "good"],
        ["path", "/ok"],
        ["domain", "example.com"]
    ]) {
        const res = await fetchTest(`http://localhost:13333/${route}?v=${encodeURIComponent(value)}`);
        console.log(route, JSON.stringify(value), res.status, await res.text());
    }

    process.exit(0);
});
