// must support cookie parser
// INSPECT
//
// Both halves of it: what it puts on the request, and what it makes of a header that is odd. A
// cookie with no value, one repeated, one whose value is not valid percent-encoding, and a JSON one
// with and without the prefix that makes it JSON.

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const cookieParser = require("cookie-parser");

const app = express();
app.set("etag", false);

app.use(cookieParser());

app.get("/read", (req, res) => {
    res.json({ cookies: req.cookies, signed: req.signedCookies });
});

// the decoder is replaceable, which an application does when its cookies are not percent-encoded
const raw = express();
raw.set("etag", false);
raw.use(cookieParser(undefined, { decode: (value) => "raw:" + value }));
raw.get("/read", (req, res) => res.json({ cookies: req.cookies }));
app.use("/raw", raw);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const cases = [
        ["plain", "abc=123; def=456"],
        ["json", `ghi=j${encodeURIComponent(":" + JSON.stringify({ n: 789 }))}`],
        ["json without the prefix", "ghi=" + encodeURIComponent(JSON.stringify({ n: 789 }))],
        ["empty value", "empty=; other=1"],
        ["repeated name", "same=first; same=second"],
        ["bad encoding", "broken=%E0%A4%A; fine=1"],
        ["no cookie header at all", null],
        ["only spaces", "   "],
        ["no equals sign", "justaname"]
    ];

    for (const [what, cookie] of cases) {
        const res = await fetchTest("http://localhost:13333/read", {
            headers: cookie === null ? undefined : { Cookie: cookie }
        });
        console.log(what.padEnd(24), res.status, await res.text());
    }

    // the same header through a decoder of the application's own
    const decoded = await fetchTest("http://localhost:13333/raw/read", { headers: { Cookie: "abc=1%202" } });
    console.log("custom decode".padEnd(24), decoded.status, await decoded.text());

    process.exit(0);
});
