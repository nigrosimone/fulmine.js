// next("router") leaves the whole router, not just the route

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

const router = express.Router();
router.get("/foo", (req, res, next) => {
    res.set("x-hit", "1");
    next("router");
});
router.get("/foo", (req, res) => res.send("failure: same router"));
app.use(router);

app.get("/foo", (req, res) => res.send("success"));

// out of the app's own router there is nothing left, so it answers like an unmatched request
app.get("/alone", (req, res, next) => next("router"));

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/foo", "/alone"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, res.headers.get("x-hit"), await res.text());
    }

    process.exit(0);
});
