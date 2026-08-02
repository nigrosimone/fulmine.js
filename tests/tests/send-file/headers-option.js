// must write the headers option exactly as it was given

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const path = require("path");

const app = express();
const file = path.join(process.cwd(), "tests/parts/small-file.json");

// Express hands the headers option to send, which writes each one through node's setHeader. Node
// does not know what a media type is, so nothing is appended: the caller asked for
// "text/x-custom" and that is what goes out. Going through res.set instead appended a charset and
// sent "text/x-custom; charset=utf-8", which is not the same media type, and for a client
// matching on the exact value it is not the one it was told to expect.
app.get("/custom-type", (req, res) => res.sendFile(file, { headers: { "Content-Type": "text/x-custom" } }));

// the same header the ordinary way, where the charset is Express's own behaviour and belongs
app.get("/type-method", (req, res) => {
    res.type("text/x-custom");
    res.sendFile(file);
});

// a type that already carries a charset must not collect a second one either way round
app.get("/custom-type-charset", (req, res) =>
    res.sendFile(file, { headers: { "Content-Type": "text/x-custom; charset=iso-8859-1" } })
);

// headers that are not a content-type pass through untouched
app.get("/plain-headers", (req, res) =>
    res.sendFile(file, { headers: { "X-Custom": "value", "Cache-Control": "no-store" } })
);

// an array is one header per entry
app.get("/array-header", (req, res) => res.sendFile(file, { headers: { "Set-Cookie": ["a=1", "b=2"] } }));

// and the option wins over a type set before it, since it is applied last
app.get("/overrides", (req, res) => {
    res.type("application/json");
    res.sendFile(file, { headers: { "Content-Type": "text/x-custom" } });
});

const ROUTES = [
    "/custom-type",
    "/type-method",
    "/custom-type-charset",
    "/plain-headers",
    "/array-header",
    "/overrides"
];

app.listen(13333, async () => {
    for (const route of ROUTES) {
        const response = await fetchTest("http://localhost:13333" + route);
        await response.text();
        console.log(
            route,
            JSON.stringify(response.headers.get("content-type")),
            JSON.stringify(response.headers.get("x-custom")),
            JSON.stringify(response.headers.get("cache-control")),
            JSON.stringify(response.headers.getSetCookie())
        );
    }

    process.exit(0);
});
