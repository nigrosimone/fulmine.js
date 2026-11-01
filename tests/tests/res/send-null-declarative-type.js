// res.type(x).send(null) compiled to a declarative response keeps the type as it was, as the
// generic path and express 5.3 do: no charset added (a fuzz divergence, seed 2684145327)

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
// with an ETag to compute the route is not compiled
app.set("etag", false);
app.get("/weird", (req, res) => {
    res.type("weird").send(null);
});
app.get("/text", (req, res) => {
    res.type("text").send(null);
});
app.get("/string", (req, res) => {
    res.type("text").send("");
});

app.listen(13333, async () => {
    await sequential(
        ["/weird", "/text", "/string"].map((path) => async () => {
            const res = await fetchTest(`http://localhost:13333${path}`);
            console.log(path, res.status, JSON.stringify(await res.text()));
        })
    );
    process.exit(0);
});
