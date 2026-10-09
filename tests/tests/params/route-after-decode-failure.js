// A parameter that does not decode: express never dispatches that route, so req.route stays as it
// was, also in a mounted router and after an earlier route that passed with next("route")

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.get("/p/:v", (req, res) => res.send("ok"));
app.get("/again/:v", (req, res, next) => next("route"));
app.get("/again/:v/:w", (req, res) => res.send("ok"));
const router = express.Router();
router.get("/q/:v", (req, res) => res.send("ok"));
app.use("/m", router);
app.use((err, req, res, next) => {
    res.status(err.status || 500).send(`route=${req.route ? req.route.path : "none"} ${err.message}`);
});

app.listen(13333, async () => {
    await sequential(
        ["/p/%E0%A4%A", "/m/q/%E0%A4%A", "/again/x", "/again/x/%E0%A4%A"].map((path) => async () => {
            const res = await fetchTest(`http://localhost:13333${path}`);
            console.log(path, res.status, await res.text());
        })
    );
    process.exit(0);
});
