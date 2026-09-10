// must close the connection when an error reaches the final handler after the head has gone out,
// as express's does: no error page can follow a head, so the client is cut off rather than left
// waiting. A response that was already ended is left as it is

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("env", "test");

app.get("/write-throw", (req, res) => {
    res.write("partial");
    throw new Error("boom");
});
app.get("/write-next-err", (req, res, next) => {
    res.write("partial");
    next(new Error("boom"));
});
app.get("/writehead-throw", (req, res) => {
    res.writeHead(201);
    throw new Error("boom");
});
app.get("/send-throw", (req, res) => {
    res.send("done");
    throw new Error("late");
});
app.get("/send-next-err", (req, res, next) => {
    res.send("done");
    next(new Error("late"));
});
app.get("/end-next", (req, res, next) => {
    res.end("done");
    next();
});

app.listen(13333, async () => {
    for (const path of [
        "/write-throw",
        "/write-next-err",
        "/writehead-throw",
        "/send-throw",
        "/send-next-err",
        "/end-next"
    ]) {
        try {
            const response = await fetchTest("http://localhost:13333" + path, { signal: AbortSignal.timeout(3000) });
            console.log(path, response.status, JSON.stringify(await response.text()));
        } catch (e) {
            console.log(path, "fetch failed:", e.name, e.cause?.code ?? e.cause?.message ?? e.message);
        }
    }
    process.exit(0);
});
