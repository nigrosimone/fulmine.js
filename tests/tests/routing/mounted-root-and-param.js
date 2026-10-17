// a router's get("/") and get("/:id") answer as express does, now that both are native
//
// The parameter needs a character, so it never takes the router's root, with or without the
// trailing slash. next() out of either one leaves the router for what the app has after it.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const messages = express.Router();
messages.use((req, res, next) => {
    res.set("x-seen", "router");
    next();
});
messages.get("/", (req, res, next) => (req.query.pass ? next() : res.send("list " + req.originalUrl)));
messages.get("/:id", (req, res, next) => (req.query.pass ? next() : res.send("item " + req.params.id)));
app.use("/api/messages", messages);

app.get("/api/messages", (req, res) => res.send("after the router"));
app.use((req, res) => res.status(404).send("no route " + req.originalUrl));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        "/api/messages",
        "/api/messages/",
        "/api/messages//",
        "/api/messages?x=1",
        "/api/messages/?x=1",
        "/api/messages/7",
        "/api/messages/7/",
        "/api/messages/7/8",
        "/api/messages/%37",
        "/API/messages/7",
        "/api/messages?pass=1",
        "/api/messages/?pass=1",
        "/api/messages/7?pass=1"
    ];
    const outputs = await sequential(
        paths.map((path) => async () => {
            const res = await fetchTest(`http://localhost:13333${path}`);
            return `${path} ${res.status} ${res.headers.get("x-seen")} ${await res.text()}`;
        })
    );
    console.log(outputs.join("\n"));
    process.exit(0);
});
