// must open random port
// INSPECT

const express = require("express");

const app = express();

app.listen(() => {
    console.log("Server is running on random port");

    process.exit(0);
});
