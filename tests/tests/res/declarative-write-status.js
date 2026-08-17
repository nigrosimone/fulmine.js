// must support declarative response write status

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

// etag off, or this is not compiled: a response that would carry a validator is refused
app.set("etag", false);

app.get("/test1", (req, res) => {
    res.sendStatus(404);
});

app.listen(13333, async () => {
    // pins the compiled path: express has no testing namespace, so this runs on our side only
    if (express.testing) express.testing.expectDeclarative(app, "*");

    const response1 = await fetchTest("http://localhost:13333/test1");
    console.log(response1.status);
    console.log(response1.statusText);

    console.log(response1.status, await response1.text());

    // sendStatus should set content-type to text/plain
    console.log("content-type:", response1.headers.get("content-type"));

    process.exit(0);
});
