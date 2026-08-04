// must support express.static() trailing slash
// INSPECT

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();

app.use((req, res, next) => {
    express.static("tests/parts")(req, res, next);
});

app.use((req, res, next) => {
    res.status(404).send("404");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const responses = await sequential([
        () => fetchTest("http://localhost:13333/trailing", { redirect: "manual" }),
        () => fetchTest("http://localhost:13333/trailing/", { redirect: "manual" }),
        () => fetchTest("http://localhost:13333/trailing/")
    ]);

    await Promise.all(responses.map((r) => r.text()));

    console.log(
        responses.map((r) => r.status),
        responses.map((r) => r.headers.get("location"))
    );

    process.exit(0);
});
