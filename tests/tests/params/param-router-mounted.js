// a mounted router's own param callbacks run for its routes, and the app's run for the app's
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const router = express.Router();

app.param("id", (req, res, next, value) => {
    console.log("app param", value);
    req.seen = (req.seen ?? "") + `app:${value} `;
    next();
});

router.param("id", (req, res, next, value) => {
    console.log("router param", value);
    req.seen = (req.seen ?? "") + `router:${value} `;
    next();
});

router.get("/users/:id", (req, res) => {
    res.send(`router route ${req.params.id} [${req.seen ?? ""}]`);
});

app.use("/api", router);

app.get("/users/:id", (req, res) => {
    res.send(`app route ${req.params.id} [${req.seen ?? ""}]`);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    let res = await fetchTest("http://localhost:13333/api/users/42");
    console.log(await res.text());
    res = await fetchTest("http://localhost:13333/users/7");
    console.log(await res.text());

    process.exit(0);
});
