// must pass the start and end options through to the read, as send does
// INSPECT

const express = require("express");
const fs = require("fs");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test", (req, res) => {
    res.sendFile("package.json", { root: ".", start: 2, end: 11 });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const expected = fs.readFileSync("package.json", "utf8").slice(2, 12);

    const response = await fetchTest("http://localhost:13333/test");
    console.log([(await response.text()) === expected, response.headers.get("content-length")]);

    // a Range header selects within the start/end window, and the total is the window's length
    const ranged = await fetchTest("http://localhost:13333/test", { headers: { Range: "bytes=0-3" } });
    console.log([(await ranged.text()) === expected.slice(0, 4), ranged.headers.get("content-length")]);

    // a HEAD answers with the window's length and no body
    const head = await fetchTest("http://localhost:13333/test", { method: "HEAD" });
    console.log([await head.text(), head.headers.get("content-length")]);

    process.exit(0);
});
