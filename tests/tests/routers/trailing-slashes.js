// must support routers with trailing slashes
// INSPECT

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
const router = express.Router();

router.get("/", (req, res) => {
    res.send("main");
});

router.get("/de", (req, res) => {
    res.send("de");
});

router.get("/test", (req, res) => {
    res.send("test");
});

router.get("/test/page/:page", (req, res) => {
    res.send(`test page ${req.params.page}`);
});

router.get("/de/test", (req, res) => {
    res.send("de test");
});

router.get("/de/test/page/:page", (req, res) => {
    res.send(`de test page ${req.params.page}`);
});

app.use("/", router);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const outputs = await sequential([
        () => fetchTest("http://localhost:13333/").then((res) => res.text()),
        () => fetchTest("http://localhost:13333/test").then((res) => res.text()),
        () => fetchTest("http://localhost:13333/test/page/123").then((res) => res.text()),
        () => fetchTest("http://localhost:13333/de/").then((res) => res.text()),
        () => fetchTest("http://localhost:13333/de/test").then((res) => res.text()),
        () => fetchTest("http://localhost:13333/de/test/page/123/").then((res) => res.text())
    ]);

    console.log(outputs);
    process.exit(0);
});
