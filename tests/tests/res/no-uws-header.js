// must remove uws header from response

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test", (req, res) => {
    res.send("ok");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    console.log((await fetchTest("http://localhost:13333/test")).headers.get("uwebsockets"));
    process.exit(0);
});
