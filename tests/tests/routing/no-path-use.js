// must support use without path
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.use(async (req, res, next) => {
    console.log("use");
    next();
});

app.get("/test", (req, res, next) => {
    res.send("test");
});

app.get("/test/test", (req, res, next) => {
    res.send("test/test");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const output1 = await fetchTest("http://localhost:13333/test").then((res) => res.text());
    const output2 = await fetchTest("http://localhost:13333/test/test").then((res) => res.text());

    console.log(output1);
    console.log(output2);
    process.exit(0);
});
