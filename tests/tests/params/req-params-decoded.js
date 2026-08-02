// must hand over route parameters decoded

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// A parameter arrives percent-encoded on the wire and reaches the application decoded, so a route
// like /users/:name works for a name with a space or an accent in it. This project handed over the
// raw text until 2026-08-02, so req.params.name was "caff%C3%A8" where Express said "caffè".
//
// The encoded slash is the case worth staring at: %2F decodes to "/" but does not split the
// segment, because the splitting happened before anything was decoded. That is why decoding has to
// come after the match and not before it.
app.get("/p/:id", (req, res) => res.json({ params: req.params }));
app.get("/two/:a/:b", (req, res) => res.json({ params: req.params }));
app.get("/files/{*rest}", (req, res) => res.json({ params: req.params }));

// A percent sequence that will not decode is the client's mistake and answers 400, rather than
// reaching the handler as broken text or throwing where nobody catches it.
app.use((err, req, res, next) => res.status(err.status || 500).json({ status: err.status, error: err.message }));

const PATHS = [
    "/p/42",
    "/p/hello%20world",
    "/p/a%2Fb",
    "/p/caff%C3%A8",
    "/p/100%25",
    "/two/a%20b/c%2Bd",
    "/files/a/b%20c",
    "/files/x%2Fy/z",
    // malformed: a stray percent, and one with a bad pair after it
    "/p/%zz",
    "/p/%E0%A4%A"
];

app.listen(13333, async () => {
    for (const path of PATHS) {
        const response = await fetchTest("http://localhost:13333" + path);
        console.log(path, response.status, await response.text());
    }

    process.exit(0);
});
