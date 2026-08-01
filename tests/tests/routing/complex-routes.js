// must support complex routes

const express = require("express");

const app = express();

app.get("/ab{c}d", (req, res) => {
    res.send("1");
});

app.get("/test{abc}test", (req, res) => {
    res.send("4");
});

app.get("/*splat", (req, res) => {
    res.send("5");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const outputs = await Promise.all([
        fetch("http://localhost:13333/abcd").then((res) => res.text()),
        fetch("http://localhost:13333/abd").then((res) => res.text()),
        fetch("http://localhost:13333/ad").then((res) => res.text()),

        fetch("http://localhost:13333/testtest").then((res) => res.text()),
        fetch("http://localhost:13333/testabctest").then((res) => res.text())
    ]);

    console.log(outputs.join(" "));
    process.exit(0);
});
