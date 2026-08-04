// must support "subdomain offset"
// INSPECT

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
const app2 = express();
app.set("subdomain offset", 0);
app2.set("subdomain offset", 1);

app.get("/abc", (req, res) => {
    res.send(req.subdomains.join("."));
});

app2.get("/abc", (req, res) => {
    res.send(req.subdomains.join("."));
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const outputs = await sequential([() => fetchTest("http://localhost:13333/abc").then((res) => res.text())]);

    console.log(outputs.join(" "));

    app2.listen(13334, async () => {
        console.log("Server is running on port 13334");

        const outputs2 = await sequential([() => fetchTest("http://localhost:13334/abc").then((res) => res.text())]);

        console.log(outputs2.join(" "));
        process.exit(0);
    });
});
