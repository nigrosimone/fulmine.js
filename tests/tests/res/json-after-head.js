// must refuse res.json() and res.jsonp() once the head has gone out, as express does through
// res.set: with an undefined body send() has nothing to refuse, so the content-type is where
// it throws, and the final handler then closes the connection. Fuzz seed 2753660276

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("env", "test");

app.get("/json-undefined", (req, res) => {
    res.writeHead(202, { "X-W": "r19" });
    res.status(202).json(undefined);
});
app.get("/json-typed", (req, res) => {
    res.writeHead(202, { "Content-Type": "application/json" });
    res.json(undefined);
});
app.get("/jsonp", (req, res) => {
    res.writeHead(202);
    res.jsonp(undefined);
});
app.get("/jsonp-typed", (req, res) => {
    res.writeHead(202, { "Content-Type": "application/json" });
    res.jsonp(undefined);
});

app.listen(13372, async () => {
    for (const path of ["/json-undefined", "/json-typed", "/jsonp", "/jsonp-typed", "/jsonp-typed?callback=cb"]) {
        try {
            const response = await fetchTest("http://localhost:13372" + path, { signal: AbortSignal.timeout(3000) });
            console.log(path, response.status, JSON.stringify(await response.text()));
        } catch (e) {
            console.log(path, "fetch failed:", e.name, e.cause?.code ?? e.cause?.message ?? e.message);
        }
    }
    process.exit(0);
});
