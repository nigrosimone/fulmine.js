// must support empty routers
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const router = express.Router();

router.get("/", (req, res) => {
    res.send("test2");
});

app.use("/test", router);

app.use((req, res, next) => {
    res.send("404");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const output1 = await fetchTest("http://localhost:13333/test").then((res) => res.text());

    console.log(output1);
    process.exit(0);
});
