// every read of req.query must answer a fresh parse: a mutation of one read must not reach the
// next, repeated keys must accumulate the same way on every read, and a url rewrite must be seen

const util = require("node:util");
const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();

app.get("/reads", (req, res) => {
    const first = req.query;
    const alias = req.query;
    first.injected = "x";
    if (Array.isArray(first.a)) {
        first.a.push("z");
    }
    const second = req.query;
    res.json({
        sameObject: first === alias,
        injectedLeaked: "injected" in second,
        second,
        inspected: util.inspect(second)
    });
});

app.use((req, res, next) => {
    if (req.path !== "/rewrite") {
        return next();
    }
    // read once before the rewrite, so a kept parse of the old url would be caught below
    if (req.query.x !== undefined) {
        return res.send("impossible");
    }
    req.url = "/target?x=9&x=8";
    next();
});

app.get("/target", (req, res) => {
    res.json({ q: req.query, again: req.query });
});

app.listen(13761, async () => {
    console.log("Server is running on port 13761");

    const responses = await sequential([
        () => fetchTest("http://localhost:13761/reads?fields=id,title&limit=10").then((res) => res.text()),
        () => fetchTest("http://localhost:13761/reads?a=1&a=2&a=3").then((res) => res.text()),
        () => fetchTest("http://localhost:13761/reads?__proto__=evil&b=2").then((res) => res.text()),
        () => fetchTest("http://localhost:13761/reads?sp=a+b&pc=c%20d&broken=%zz").then((res) => res.text()),
        () => fetchTest("http://localhost:13761/reads").then((res) => res.text()),
        () => fetchTest("http://localhost:13761/rewrite").then((res) => res.text())
    ]);

    console.log(responses);

    process.exit(0);
});
