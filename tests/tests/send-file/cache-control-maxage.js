// must write a max-age a cache can actually read

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const path = require("path");

const app = express();
const file = path.join(process.cwd(), "tests/parts/small-file.json");

// max-age takes a non-negative whole number of seconds. A fraction, a negative number or Infinity
// are not merely unusual, they are invalid, and a client that cannot read the directive is entitled
// to discard the whole Cache-Control header, which leaves the response with no caching policy at
// all. This wrote max-age=0.5, max-age=-1, max-age=Infinity and max-age=NaN until 2026-08-02.
const CASES = [
    ["/zero", 0],
    ["/fraction", 500],
    ["/negative", -1000],
    ["/infinity", Infinity],
    ["/beyond-a-year", 99999999999],
    ["/duration-string", "1d"],
    ["/unreadable-duration", "not a duration"],
    ["/undefined", undefined]
];

for (const [route, maxAge] of CASES) {
    app.get(route, (req, res) => res.sendFile(file, { maxAge }));
}

// immutable rides along on the same header, so it is worth seeing next to a rounded value
app.get("/immutable", (req, res) => res.sendFile(file, { maxAge: 3600000, immutable: true }));

// and the header can be turned off entirely
app.get("/no-cache-control", (req, res) => res.sendFile(file, { maxAge: 3600000, cacheControl: false }));

app.listen(13333, async () => {
    for (const [route, maxAge] of CASES) {
        const response = await fetchTest("http://localhost:13333" + route);
        await response.text();
        console.log(route, String(maxAge), response.headers.get("cache-control"));
    }

    for (const route of ["/immutable", "/no-cache-control"]) {
        const response = await fetchTest("http://localhost:13333" + route);
        await response.text();
        console.log(route, response.headers.get("cache-control"));
    }

    process.exit(0);
});
