// test the wording thrown for bad "etag" and "query parser" values, and that a true
// INSPECT
// "query parser" parses like "simple"

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

try {
    app.set("etag", 42);
} catch (err) {
    console.log("etag:", err.constructor.name, err.message);
}

try {
    app.set("query parser", "bogus");
} catch (err) {
    console.log("query parser:", err.constructor.name, err.message);
}

app.set("query parser", true);
app.get("/", (req, res) => res.send(JSON.stringify(req.query)));

app.listen(13333, async () => {
    const res = await fetchTest("http://localhost:13333/?user%5Bname%5D=tj");
    console.log("query:", await res.text());
    process.exit(0);
});
