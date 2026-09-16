// under "declarative request values" a body with a query value or a route parameter in it
// compiles, and answers as Express does while the values are plain

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);
app.set("declarative request values", true);

app.get("/user/:id", (req, res) => res.send(req.params.id));
app.get("/user/:id/name", (req, res) => res.type("text/plain").send(`user ${req.params.id}`));
app.get("/q", (req, res) => res.send(req.query.name));
app.get("/both/:id", (req, res) => res.send(req.params.id + " " + req.query.name));

app.listen(13333, async () => {
    // pins the compiled path: express has no testing namespace, so this runs on our side only
    if (express.testing) express.testing.expectDeclarative(app, "*");

    for (const url of [
        "http://localhost:13333/user/42",
        "http://localhost:13333/user/42/",
        "http://localhost:13333/user/42/name",
        "http://localhost:13333/q?name=simone",
        "http://localhost:13333/both/7?name=x"
    ]) {
        const res = await fetchTest(url);
        console.log(await res.text());
    }
    process.exit(0);
});
