// req.params must have null prototype
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/users/:id", (req, res) => {
    const hasToString = "toString" in req.params;
    const hasHasOwn = "hasOwnProperty" in req.params;
    res.json({
        id: req.params.id,
        hasToString,
        hasHasOwn
    });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const response = await fetchTest("http://localhost:13333/users/42").then((res) => res.text());
    console.log(response);

    process.exit(0);
});
