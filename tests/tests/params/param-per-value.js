// app.param() runs once per value and not once per request, and a value already seen brings back
// INSPECT
// what its callback left behind

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

let called = 0;

// two routes match the same request with a different value for the same name, so it runs twice
app.param("user", (req, res, next, user) => {
    called++;
    req.users = (req.users || []).concat(user);
    next();
});
app.get("/differ/:user/bob", (req, res, next) => next());
app.get("/differ/foo/:user", (req, res, next) => next());
app.use("/differ", (req, res) => res.send(`${called} ${req.users.join(",")}`));

// a callback that rewrites req.params hands the new value to the routes after it
app.param("name", (req, res, next) => {
    req.params.name = "loki";
    next();
});
app.get("/alter/:name", (req, res, next) => next("route"));
app.get("/alter/:name", (req, res) => res.send(req.params.name));

// next("route") is replayed for every route that matches the same value, so the literal wins
app.param("id", (req, res, next, id) => (id === "new" ? next("route") : next()));
app.all("/defer/:id", (req, res) => res.send("all.id"));
app.get("/defer/:id", (req, res) => res.send("get.id"));
app.get("/defer/new", (req, res) => res.send("get.new"));

// what a callback throws reaches the error handler instead of hanging the request
app.param("thing", () => {
    throw new Error("boom");
});
app.get("/thrown/:thing", (req, res) => res.send("never"));

app.use((err, req, res, next) => res.status(500).send(err.message));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/differ/foo/bob", "/alter/bob", "/defer/new", "/defer/7", "/thrown/x"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
