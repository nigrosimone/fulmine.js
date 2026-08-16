// an earlier route that answers only the trailing slash spelling of a path
//
// Without strict routing a native registration answers "/x/" as well as "/x", so a route written
// before it that matches "/x/" has to run first. It was put into the compiled chain whole, and the
// chain runs what is in it without matching again, so it answered "/x" as well and the route
// written after it never ran.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// the slashes around an optional group are literal, so this one answers "/list/Mixed/" and not
// "/list/Mixed"
app.all("/:p0/{:o1}/{:o2}", (req, res) => res.json(null));
// sets a header, so it is a compiled chain that answers it and not a declarative response, which
// would be written by µWS with no chain to get wrong
app.get("/list/Mixed", (req, res) => res.location("/moved").send("the later route"));

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/list/Mixed", "/list/Mixed?q", "/list/Mixed/", "/list/Mixed/x", "/other/thing/"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
