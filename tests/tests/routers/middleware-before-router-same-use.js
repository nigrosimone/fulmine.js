// must run middlewares in the same use() call as a mounted router
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const router = express.Router();

router.get("/data", (req, res) => {
    res.send("secret");
});

app.use(
    "/private",
    (req, res, next) => {
        if (req.headers.authorization === "yes") return next();
        res.status(401).send("denied");
    },
    router
);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await new Promise((resolve) => setTimeout(resolve, 200));

    let res = await fetchTest("http://localhost:13333/private/data");
    console.log(res.status, await res.text());

    res = await fetchTest("http://localhost:13333/private/data", {
        headers: { authorization: "yes" }
    });
    console.log(res.status, await res.text());

    process.exit(0);
});
