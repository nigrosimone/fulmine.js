// must answer a conditional request the way its path can answer it

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// Same route twice. The first compiles into a declarative response, which uWS writes natively and
// which has no way to branch on the request, so it cannot answer 304. The second calls something
// the compiler does not follow, so it is served by the ordinary path and can.
app.get("/compiled", (req, res) => {
    res.set("ETag", '"abc"');
    res.send("body");
});
app.get("/ordinary", (req, res) => {
    res.set("ETag", '"abc"');
    res.send(["b", "o", "d", "y"].join(""));
});

// Fulmine answers the compiled route 200 where Express answers 304, so this asks which server it
// is running on rather than comparing the two directly. Sending the whole body is a valid answer
// to a conditional request, it is just the slower one. app.set("declarative responses", false)
// gives up the native path and gets Express's answer back.
const isFulmine = !!app.uwsApp;

app.listen(13333, async () => {
    // max-age is not decoration: fetch adds "cache-control: no-cache" of its own whenever the
    // request carries a conditional header, and that alone makes req.fresh false.
    const matching = { headers: { "if-none-match": '"abc"', "cache-control": "max-age=604800" } };

    // plain fetch for the compiled route, since fetchTest prints the status and that is exactly
    // what differs here. The ordinary route is compared header by header as everywhere else.
    const [compiled, ordinary] = await Promise.all([
        fetch("http://localhost:13333/compiled", matching),
        fetchTest("http://localhost:13333/ordinary", matching)
    ]);

    const compiledBody = await compiled.text();
    const ordinaryBody = await ordinary.text();

    console.log("ordinary route answers 304:", ordinary.status === 304 && ordinaryBody === "");
    console.log(
        "compiled route answers as this server can:",
        isFulmine ? compiled.status === 200 && compiledBody === "body" : compiled.status === 304 && compiledBody === ""
    );

    process.exit(0);
});
