// must support errorhandler middleware
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");
const errorhandler = require("errorhandler");

const app = express();

// errorhandler logs from a setImmediate, so the line is printed after the response, in both arms
let logged;
const message = new Promise((resolve) => (logged = resolve));

app.get("/abc", (req, res) => {
    throw new Error("test");
});

app.use(
    errorhandler({
        log: (err) => logged(err.message)
    })
);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    await fetchTest("http://localhost:13333/abc");
    console.log(`hi`, await message);

    process.exit(0);
});
