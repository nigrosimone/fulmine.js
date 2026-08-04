// must handle async errors natively without express-async-errors
// INSPECT

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("env", "production");

app.get("/test", async (req, res) => {
    throw new Error("async error");
});

app.get("/test2", async (req, res) => {
    await Promise.reject(new Error("rejected promise"));
});

app.use((err, req, res, next) => {
    res.status(500).send("caught: " + err.message);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const responses = await sequential([
        () => fetchTest("http://localhost:13333/test").then((res) => res.text()),
        () => fetchTest("http://localhost:13333/test2").then((res) => res.text())
    ]);

    console.log(responses);
    process.exit(0);
});
