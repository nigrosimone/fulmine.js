// must support router operators

const express = require("express");

const app = express();

const router = express.Router();

// all request property to check
const reqKeys = [
    "httpVersionMajor",
    "httpVersionMinor",
    "httpVersion",
    "rawHeaders",
    "url",
    "method",
    "baseUrl",
    "originalUrl",
    "params",
    "query",
    "body"
];
const checkReq = (req) => {
    const _req = {};
    for (const key of reqKeys) {
        _req[key] = req[key];
    }
    return _req;
};

// This route path will match acd and abcd.
router.get("/a{b}cd", (req, res) => {
    res.json({ test: "a{b}cd", checkReq: checkReq(req) });
});

// This route path will match /abe and /abcde.
router.get("/ab{cd}e", (req, res) => {
    res.json({ test: "ab{cd}e", checkReq: checkReq(req) });
});

app.use(router);
app.use("/sub", router);
app.use("/sub/:id", router);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const parts = ["acd", "abcd", "abe", "abcde"];
    const responses1 = await Promise.all(
        parts.map((part) => fetch(`http://localhost:13333/${part}?a=1&a=2&b=3`).then((res) => res.json()))
    );
    console.log(JSON.stringify(responses1, null, 2));

    const responses2 = await Promise.all(
        parts.map((part) => fetch(`http://localhost:13333/sub/${part}/?c=4#foo`).then((res) => res.json()))
    );
    console.log(JSON.stringify(responses2, null, 2));

    const responses3 = await Promise.all(
        parts.map((part) => fetch(`http://localhost:13333/sub/123/${part}`).then((res) => res.json()))
    );
    console.log(JSON.stringify(responses3, null, 2));

    process.exit(0);
});
