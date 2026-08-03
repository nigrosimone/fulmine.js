// test that a head written before the automatic OPTIONS reply sends the error to the error
// handlers instead of answering with the methods

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
const router = express.Router();

router.get("/users", (req, res) => {});

app.use((req, res, next) => {
    res.writeHead(200);
    next();
});
app.use(router);
app.use((err, req, res, next) => {
    console.log("error:", err.message);
    res.end("true");
});

app.listen(13333, async () => {
    const res = await fetchTest("http://localhost:13333/users", { method: "OPTIONS" });
    console.log("body:", await res.text());
    process.exit(0);
});
