// a body with a piece of the request in it is not compiled by default: uWS writes the value as
// it reads it, and Express answers a repeated key with an array and a missing one with undefined

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
// etag off is what would put these on the compiled path, and they must stay off it anyway
app.set("etag", false);

app.get("/alone", (req, res) => res.send(req.query.name));
app.get("/inside", (req, res) => res.send(`hi ${req.query.name}`));
app.get("/joined", (req, res) => res.send("x" + req.query.n + "y"));

app.listen(13333, async () => {
    // the literal bodies still compile, and nothing here may: express has no testing namespace,
    // so this runs on our side only
    if (express.testing) {
        express.testing.expectNative(app, "*");
        for (const entry of express.testing.routeReport(app)) {
            if (entry.declarative) throw new Error(`${entry.path} was compiled`);
        }
    }

    for (const url of [
        "http://localhost:13333/alone?name=x&name=y",
        "http://localhost:13333/alone",
        "http://localhost:13333/alone?name=a%20b",
        "http://localhost:13333/inside",
        "http://localhost:13333/inside?name=x&name=y",
        "http://localhost:13333/joined",
        "http://localhost:13333/joined?n=1&n=2"
    ]) {
        const res = await fetchTest(url);
        console.log(await res.text());
    }
    process.exit(0);
});
