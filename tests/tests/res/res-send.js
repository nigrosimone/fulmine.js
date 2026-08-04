// must support res.send()
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.set("declarative responses", false);

app.get("/test", (req, res) => {
    res.send("Hello World");
});

app.get("/json", (req, res) => {
    res.send({
        message: "Hello World"
    });
});

app.get("/buffer", (req, res) => {
    res.send(Buffer.from("asf"));
});

app.get("/null", (req, res) => {
    res.send(null);
});

app.get("/undefined", (req, res) => {
    res.send(undefined);
});

app.get("/number", (req, res) => {
    res.send(202);
});

app.get("/number2", (req, res) => {
    res.send(203, "test");
});

app.get("/boolean", (req, res) => {
    res.send(true);
});

app.get("/arraybuffer", (req, res) => {
    const ab = new ArrayBuffer(10);
    const view = new Uint8Array(ab);
    view[0] = 10;
    res.send(ab);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const responses = [
        await fetchTest("http://localhost:13333/test"),
        await fetchTest("http://localhost:13333/json"),
        await fetchTest("http://localhost:13333/buffer"),
        await fetchTest("http://localhost:13333/null"),
        await fetchTest("http://localhost:13333/undefined"),
        await fetchTest("http://localhost:13333/number"),
        await fetchTest("http://localhost:13333/number2"),
        await fetchTest("http://localhost:13333/boolean"),
        await fetchTest("http://localhost:13333/arraybuffer")
    ];

    for await (const response of responses) {
        console.log(response.url);
        console.log(response.status + " " + response.statusText);
        console.log(response.headers.get("content-type"));
        console.log(await response.text());
    }

    process.exit(0);
});
