// an error already in flight wins over the one an app.param callback raises on the way into a mount

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// Express skips routes while an error is pending but still enters a use() layer, and runs the
// param callbacks its path captured first. Whatever they answer with, the pending error is the one
// that goes on: next(layerError || err) in router/index.js
const router = express.Router();
router.param("id", (req, res, next, value) => (value === "bad" ? next(new Error("param refused " + value)) : next()));
router.get("/bad", (req, res, next) => next(new Error("route bad failed")));
router.get("/good", (req, res, next) => next(new Error("route good failed")));

const nested = express.Router();
nested.get("/x", (req, res) => res.send("nested " + req.params.id));
// reached with the pending error when the param callback let the mount be entered
nested.use((err, req, res, next) => res.status(500).send("nested caught: " + err.message));
router.use("/:id", nested);

app.use("/r", router);
app.use((err, req, res, next) => res.status(500).send("error: " + err.message));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(
        ["/r/bad", "/r/good", "/r/bad/x", "/r/good/x"].map((path) => async () => {
            const res = await fetchTest("http://localhost:13333" + path);
            console.log(path, res.status, await res.text());
        })
    );
    process.exit(0);
});
