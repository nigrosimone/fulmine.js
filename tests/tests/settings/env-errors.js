// must support "env" errors
// INSPECT

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
const app2 = express();
app.set("env", "production");
app2.set("env", "development");

app.get("/abc", (req, res) => {
    throw new Error("Ignore this error, its used in a test");
});

app2.get("/abc", (req, res) => {
    throw new Error("Ignore this error, its used in a test");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const outputs = await sequential([() => fetchTest("http://localhost:13333/abc").then((res) => res.text())]);

    console.log(outputs.join(" ").includes("Internal Server Error"));

    app2.listen(13334, async () => {
        console.log("Server is running on port 13334");

        const outputs2 = await sequential([() => fetchTest("http://localhost:13334/abc").then((res) => res.text())]);

        console.log(outputs2.join(" ").includes("Ignore this error, its used in a test"));
        process.exit(0);
    });
});
