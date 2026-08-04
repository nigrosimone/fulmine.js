// must support app.param and router.param with a named handler
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const router = express.Router();

// Express 5 keeps only the two-argument form. The v4 handler-factory form, app.param(fn),
// is covered by app/app-param-deprecated.
app.param("id", function (req, res, next, val) {
    console.log("app param", val);
    next();
});

router.param("rid", function (req, res, next, val) {
    console.log("router param", val);
    next();
});

app.get("/user/:id", (req, res, next) => {
    console.log("before");
    next();
});

app.get("/user/:id", function (req, res, next) {
    console.log("although this matches");
    next();
});

app.get("/user/:id", function (req, res) {
    console.log("and this matches too");
    res.send("test");
});

router.get("/:rid", (req, res) => {
    res.send("routertest");
});

app.use("/test", router);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const response = await fetchTest("http://localhost:13333/user/123");
    console.log(response.status);
    const response2 = await fetchTest("http://localhost:13333/test/123");
    console.log(response2.status);
    const response3 = await fetchTest("http://localhost:13333/user/555").then((res) => res.text());
    console.log(response3);

    process.exit(0);
});
