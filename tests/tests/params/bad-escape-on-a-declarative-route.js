// a route that captures something cannot answer declaratively
//
// A declarative response is written by µWS itself and no javascript runs for it, so the captured
// value is never decoded. A path express refuses with a 400 came back 200 with the compiled body.
// Found by fuzzing the framework against itself with the optimizer off.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// the shape the compiler takes: one route, one callback, a body that does not read the request
app.get("/p/:id", (req, res) => res.end("ok"));
// captures nothing, so this one is still free to be compiled
app.get("/literal", (req, res) => res.end("ok"));

// express's own page prints its own frames, which can never match
app.use((err, req, res, next) => res.status(err.status ?? 500).send("error: " + err.message));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/p/a-b%5Ec@d%e", "/p/%", "/p/good", "/p/a%20b", "/literal"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, JSON.stringify(await res.text()));
    }

    process.exit(0);
});
