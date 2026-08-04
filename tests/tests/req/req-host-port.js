// req.host must include the port number
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/test", (req, res) => {
    res.send(req.host || "undefined");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const response = await fetchTest("http://localhost:13333/test", {
        headers: { Host: "example.com:8080" }
    }).then((res) => res.text());
    console.log(response);

    const response2 = await fetchTest("http://localhost:13333/test", {
        headers: { Host: "example.com" }
    }).then((res) => res.text());
    console.log(response2);

    process.exit(0);
});
