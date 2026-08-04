// a regex mount inside a mounted router, matching the root the parent mount consumed
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

const router = express.Router();
router.use(/^\/$/, (req, res, next) => {
    res.set("x-root-mw", "hit");
    next();
});
router.get("/", (req, res) => res.send("root"));
router.get("/deep", (req, res) => res.send("deep"));
app.use("/api", router);

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/api", "/api/", "/api/deep"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, res.headers.get("x-root-mw"), await res.text());
    }

    process.exit(0);
});
