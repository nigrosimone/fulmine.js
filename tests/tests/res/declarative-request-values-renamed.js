// a destructured req a minifier renamed ({ params: { id: c } }) answers the values, not their names
// (no INSPECT: its middleware keeps every route off the compiled path)

// The compiler kept the local name of a destructured param and asked uWS for a parameter called
// "c": the body came out as one space. Bun.build, esbuild and terser all leave this shape.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);
app.set("declarative request values", true);

// shorthand, the shape a person writes
app.get("/short/:id", ({ params: { id }, query: { name } }, res) => {
    res.setHeader("content-type", "text/plain").send(`${id} ${name}`);
});
// the same handler after a minifier
app.get("/renamed/:id", ({ params: { id: c }, query: { name: i } }, a) => {
    a.setHeader("content-type", "text/plain").send(`${c} ${i}`);
});
// renamed on one side only
app.get("/mixed/:id", ({ params: { id }, query: { name: n } }, res) => {
    res.send(id + ":" + n);
});
// a key the route does not have, and a rest element: neither must compile into anything
app.get("/other/:id", ({ params: { nope: c } }, res) => {
    res.send(`[${c}]`);
});
app.get("/rest/:id", ({ params: { ...all } }, res) => {
    res.send(JSON.stringify(all));
});

app.listen(13333, async () => {
    if (express.testing) express.testing.expectDeclarative(app, ["/short/:id", "/renamed/:id"]);

    for (const url of [
        "http://localhost:13333/short/1?name=bun",
        "http://localhost:13333/renamed/1?name=bun",
        "http://localhost:13333/renamed/42?name=a%20b",
        "http://localhost:13333/mixed/3?name=x",
        "http://localhost:13333/other/5",
        "http://localhost:13333/rest/9"
    ]) {
        const res = await fetchTest(url);
        console.log(JSON.stringify(await res.text()));
    }
    process.exit(0);
});
