// must support errorhandler middleware
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const errorhandler = require("errorhandler");

const app = express();

app.get("/abc", (req, res) => {
    throw new Error("test");
});

app.use(
    errorhandler({
        log: (err) => {
            console.log(`hi`, err.message);
        }
    })
);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    await fetchTest("http://localhost:13333/abc");

    process.exit(0);
});
