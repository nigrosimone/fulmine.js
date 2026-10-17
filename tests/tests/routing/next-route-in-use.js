// next("route") in a callback of use(path, f1, f2) goes on to f2
//
// Express makes each callback of use() a layer of its own, and its router turns next("route") into
// next() there: the next layer runs. Fulmine left the whole use(). A param callback's next("route")
// still skips every callback of it, as express skips the layers through its param cache.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
const show = (tag) => (req, res, next) => {
    (req.seen ??= []).push(`${tag}=${req.baseUrl}`);
    next();
};
const answer = (req, res) => res.json(req.seen ?? []);

app.use("/a", (req, res, next) => next("route"), show("second"));
app.get("/a/x", show("after"), answer);

app.use("/b", show("f1"), (req, res, next) => next("route"), show("f3"));
app.get("/b/x", show("after"), answer);

app.param("pid", (req, res, next) => next("route"));
app.use("/u/:pid", show("f1"), show("f2"));
app.get("/u/:pid/x", show("after"), answer);

const r = express.Router();
r.param("rid", (req, res, next) => next("route"));
r.use("/v/:rid", show("f1"), show("f2"));
r.use(show("rafter"));
app.use(r);
app.get("/v/:rid/x", show("after"), answer);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = ["/a/x", "/b/x", "/u/3/x", "/v/3/x"];
    const outputs = await sequential(
        paths.map((path) => async () => {
            const res = await fetchTest(`http://localhost:13333${path}`);
            return `${path} ${res.status} ${await res.text()}`;
        })
    );
    console.log(outputs.join("\n"));
    process.exit(0);
});
