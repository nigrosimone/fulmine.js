// must send the body when an empty write comes before end, as express-session ends a response

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.get("/buffer", (req, res) => {
    res.set("Content-Length", "1");
    res.write(Buffer.alloc(0));
    setImmediate(() => res.end("1"));
});

app.get("/string", (req, res) => {
    res.set("Content-Length", "2");
    res.write("");
    res.end("ab");
});

app.get("/zero", (req, res) => {
    res.set("Content-Length", "0");
    res.write("");
    res.end();
});

app.listen(13333, async () => {
    for (const path of ["/buffer", "/string", "/zero"]) {
        const response = await fetchTest(`http://localhost:13333${path}`, { signal: AbortSignal.timeout(3000) });
        console.log(
            path,
            response.status,
            response.headers.get("content-length"),
            JSON.stringify(await response.text())
        );
    }
    process.exit(0);
});
