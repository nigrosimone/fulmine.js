// an automatic OPTIONS reply does not run the app.param() callbacks of the routes it counted
//
// A route whose verb the reply is collecting is not a route the request runs, so express never
// reaches its parameter callbacks. Here the walk decoded the parameters and then ran them anyway,
// which is visible whenever such a callback does anything: the one below writes a header, so the
// answer to OPTIONS carried a header express does not send, and a callback that throws turned the
// automatic 200 into a 500.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const router = express.Router();
// writes something the response carries, so whether it ran is visible from outside
router.param("p", (req, res, next, value) => {
    res.set("X-Param-Ran", String(value));
    next();
});
// no OPTIONS route and no all(), so OPTIONS gets the automatic reply built from these two
router.put("/:p/thing", (req, res) => res.json({ r: "put", params: req.params }));
router.post("/:p/thing", (req, res) => res.json({ r: "post", params: req.params }));
// a route that does answer OPTIONS, whose callbacks must still run
router.options("/:p/answered", (req, res) => res.json({ r: "options", params: req.params }));
app.use(router);

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const [method, path] of [
        // counted only, so the callback must not run
        ["OPTIONS", "/abc/thing"],
        // runs the route, so it must
        ["PUT", "/abc/thing"],
        ["POST", "/abc/thing"],
        // answered by a route of its own, so it must run here too
        ["OPTIONS", "/abc/answered"],
        // nothing matches, so there is nothing to count
        ["OPTIONS", "/abc/absent"]
    ]) {
        const res = await fetchTest(`http://localhost:13333${path}`, { method });
        console.log(
            method,
            path,
            res.status,
            res.headers.get("allow"),
            res.headers.get("x-param-ran"),
            await res.text()
        );
    }

    process.exit(0);
});
