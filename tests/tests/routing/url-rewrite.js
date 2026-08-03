// assigning req.url in middleware re-routes the rest of the stack, path and query alike

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/rewrite", (req, res, next) => {
    req.url = "/rewritten?changed=1";
    next();
});
app.get("/rewritten", (req, res) => res.json({ path: req.path, query: req.query }));

// inside a mounted router the assignment is relative to the mount
const router = express.Router();
router.get("/from", (req, res, next) => {
    req.url = "/to";
    next();
});
router.get("/to", (req, res) => res.send(`router saw ${req.url} of ${req.originalUrl}`));
app.use("/api", router);

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/rewrite?orig=1", "/api/from", "/rewritten?direct=1"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
