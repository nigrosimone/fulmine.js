// app.param() callbacks as router 2 runs them: a rejected promise goes to the error handlers, and
// the route runs inside the callback's next(), before the code after it
// INSPECT

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();

app.param("rej", async function rejecting() {
    throw new Error("param reject");
});
app.param("empty", async function rejectingEmpty() {
    throw undefined;
});
app.param("id", function (req, res, next) {
    req.trail = ["param"];
    next();
    req.trail.push("after next");
});

app.get("/rej/:rej", (req, res) => res.send("never"));
app.get("/empty/:empty", (req, res) => res.send("never"));
app.get("/user/:id", (req, res) => {
    req.trail.push("handler");
    res.send(req.trail.join(","));
});

app.use((err, req, res, next) => {
    res.status(500).send(`handled ${err.message}`);
});

app.listen(13333, async () => {
    await sequential(
        ["/rej/1", "/empty/1", "/user/1"].map((path) => async () => {
            const res = await fetchTest(`http://localhost:13333${path}`);
            console.log(path, await res.text());
        })
    );
    process.exit(0);
});
