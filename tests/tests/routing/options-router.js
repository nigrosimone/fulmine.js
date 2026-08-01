// must support OPTIONS method stopping in the router

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const router = express.Router();

router.get("/test", (req, res) => {
    res.send("hello");
});

app.use("/router", router);

app.use((req, res, next) => {
    res.status(404).send(`not found ${req.method} ${req.url}`);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    let res = await fetchTest("http://localhost:13333/router/test", { method: "OPTIONS" });
    console.log(await res.text(), res.status, res.headers.get("allow"));

    res = await fetchTest("http://localhost:13333/router/test2", { method: "OPTIONS" });
    console.log(await res.text(), res.status, res.headers.get("allow"));

    res = await fetchTest("http://localhost:13333/router/test", { method: "GET" });
    console.log(await res.text(), res.status, res.headers.get("allow"));

    process.exit(0);
});
