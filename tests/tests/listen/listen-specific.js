// must open specified port
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.listen(13333, () => {
    console.log("Server is running on port 13333");

    fetchTest("http://localhost:13333")
        .then((res) => res.text())
        .then((body) => {
            console.log(body);
            process.exit(0);
        })
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
});
