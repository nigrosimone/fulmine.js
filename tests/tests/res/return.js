// must support return
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/", async (req, res) => {
    return res.send("ok");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const responses = await fetchTest("http://localhost:13333/").then((res) => res.text());

    console.log(responses);
    process.exit(0);
});
