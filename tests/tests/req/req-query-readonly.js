// req.query must be read-only (assignment silently ignored)

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test", (req, res) => {
    const origQuery = JSON.stringify(req.query);
    let threw = false;
    try {
        req.query = { custom: "value" };
    } catch (e) {
        threw = true;
    }
    const afterQuery = JSON.stringify(req.query);
    res.json({ threw, origQuery, afterQuery, changed: origQuery !== afterQuery });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const response = await fetchTest("http://localhost:13333/test?a=1").then((res) => res.text());
    console.log(response);
    process.exit(0);
});
