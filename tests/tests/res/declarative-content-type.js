// must support declarative response content-type

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// etag off, or none of this is compiled: a response that would carry a validator is refused
app.set("etag", false);

app.get("/test1", (req, res) => {
    res.setHeader("Content-Type", "text/plain").send(`test1`);
});

app.get("/test2", (req, res) => {
    res.send(`test2`);
});

app.listen(13333, async () => {
    // pins the compiled path: express has no testing namespace, so this runs on our side only
    if (express.testing) express.testing.expectDeclarative(app, "*");

    const response1 = await fetchTest("http://localhost:13333/test1");
    console.log(response1.headers.get("content-type"));
    console.log(await response1.text());

    const response2 = await fetchTest("http://localhost:13333/test2");
    console.log(response2.headers.get("content-type"));
    console.log(await response2.text());

    process.exit(0);
});
