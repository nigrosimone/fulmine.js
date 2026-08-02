// must hang the same things off the export as Express does

const express = require("express");
const { fetchTest } = require("../../helpers.js");

// express.application was missing until 2026-08-02, and missing quietly: it was only ever assigned
// in a block of `exports.x = ...` that followed `module.exports = ...`, which detaches `exports`
// and makes every line after it write to an object nobody can reach. Everything else in that block
// happened to be assigned again above it, so nothing looked wrong.
const EXPORTS = ["Router", "request", "response", "application", "static", "json", "urlencoded", "text", "raw"];

for (const name of EXPORTS) {
    console.log(name, typeof express[name]);
}

// the point of the three prototypes: a method added to one is on every request, response or app
express.application.appHelper = function () {
    return "app helper";
};
express.request.reqHelper = function () {
    return "req helper";
};
express.response.resHelper = function () {
    return "res helper";
};

const app = express();

console.log("app helper reaches the app:", app.appHelper());

app.get("/helpers", (req, res) => {
    res.send([req.reqHelper(), res.resHelper()].join(", "));
});

app.listen(13333, async () => {
    const response = await fetchTest("http://localhost:13333/helpers");
    console.log(await response.text());
    process.exit(0);
});
