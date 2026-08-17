// must support res.send() declarative

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.set("declarative responses", true);
// and etag off, or none of this is compiled: a response that would carry a validator is refused
app.set("etag", false);

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
    // pins the compiled path: express has no testing namespace, so this runs on our side only. The
    // rest of the routes send a shape the compiler does not follow and are the fallback half
    if (express.testing) express.testing.expectDeclarative(app, ["/test", "/json", "/null", "/boolean"]);

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
        console.log([
            response.url,
            response.status + " " + response.statusText,
            response.headers.get("content-type"),
            await response.text()
        ]);
    }

    process.exit(0);
});
