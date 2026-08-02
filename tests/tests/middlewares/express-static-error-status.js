// must tell the error handler which failure it was

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const fs = require("fs");

const size = fs.statSync("tests/parts/small-file.json").size;
const app = express();

app.use("/deny", express.static("tests/parts", { dotfiles: "deny", fallthrough: false }));
app.use("/nofall", express.static("tests/parts", { fallthrough: false }));
app.use("/noindex", express.static("tests/parts", { index: false, fallthrough: false }));
app.use("/noredirect", express.static("tests/parts", { redirect: false, fallthrough: false }));
app.use("/plain", express.static("tests/parts"));

// the error handler almost every Express application has. It reads err.status, so an error that
// carries none answers 500 to a request that was merely conditional, and the client cannot tell
// its own bad request from a broken server.
app.use((err, req, res, next) => {
    res.status(err.status || 500).send(`status=${err.status} code=${err.code} message=${err.message}`);
});

const CASES = [
    // a file that exists, and conditions the client itself set. These are the two that fallthrough
    // used to swallow: a Range Not Satisfiable came back as a 404, which tells the client its file
    // is gone when it is not. serve-static forwards anything that happens once send has settled on
    // a file, whether fallthrough is on or not.
    ["/plain/small-file.json", { Range: `bytes=${size + 100}-${size + 200}` }],
    ["/nofall/small-file.json", { Range: `bytes=${size + 100}-${size + 200}` }],
    ["/plain/small-file.json", { "If-Match": '"nomatch"' }],
    ["/nofall/small-file.json", { "If-Match": '"nomatch"' }],
    ["/plain/small-file.json", { "If-Unmodified-Since": "Sat, 01 Jan 2000 00:00:00 GMT" }],

    // and a range that is satisfiable, so the fix cannot have made everything an error
    ["/plain/small-file.json", { Range: "bytes=0-4" }],

    // the ones that do mean "not a file here", which still fall through when they may
    ["/deny/.test.txt", {}],
    ["/nofall/.test.txt", {}],
    ["/plain/.test.txt", {}],
    ["/nofall/%ZZ", {}],
    ["/nofall/../../package.json", {}],
    ["/noindex/subapp/", {}],
    ["/noredirect/subapp", {}]
];

app.listen(13333, async () => {
    for (const [path, headers] of CASES) {
        const response = await fetchTest("http://localhost:13333" + path, { headers });
        const body = await response.text();
        // the served 404 page is long and full of markup, so only its first line is worth printing
        console.log(path, JSON.stringify(headers), response.status, JSON.stringify(body.split("\n")[0].slice(0, 60)));
    }

    process.exit(0);
});
