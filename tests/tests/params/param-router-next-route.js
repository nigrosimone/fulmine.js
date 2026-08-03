// next("route") from a param callback of a mounted router, with and without a route after it

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// nothing follows the parameter route in this router, which is the shape that reaches µWS
const alone = express.Router();
alone.param("id", (req, res, next, value) => {
    console.log("alone param", value);
    if (value === "skip") {
        return next("route");
    }
    next();
});
alone.get("/:id", (req, res) => res.send(`alone ${req.params.id}`));
app.use("/alone", alone);

// and here something does, so the skipped request has somewhere to land inside the router
const pair = express.Router();
pair.param("id", (req, res, next, value) => {
    console.log("pair param", value);
    if (value === "skip") {
        return next("route");
    }
    next();
});
pair.get("/:id", (req, res) => res.send(`pair first ${req.params.id}`));
pair.get("/skip", (req, res) => res.send("pair second"));
app.use("/pair", pair);

app.use((req, res) => res.status(404).send(`nothing matched ${req.url}`));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/alone/42", "/alone/skip", "/pair/42", "/pair/skip"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
