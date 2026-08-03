// must invoke the sendFile callback without error on HEAD and on 304

const http = require("http");
const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

const events = [];

app.get("/test", (req, res) => {
    res.sendFile("src/index.js", { root: "." }, (err) => {
        events.push(err ? `error ${err.status}` : "ok");
    });
});

// node http and not fetch: undici does not deliver If-None-Match, so the conditional half of
// this test would silently test nothing
function get(headers) {
    return new Promise((resolve) => {
        http.get({ port: 13333, path: "/test", headers }, (res) => {
            res.resume();
            res.on("end", () => resolve({ status: res.statusCode, etag: res.headers.etag }));
        });
    });
}

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    await fetchTest("http://localhost:13333/test", { method: "HEAD" });

    const response = await fetchTest("http://localhost:13333/test");
    await response.text();
    const etag = response.headers.get("etag");

    const conditional = await get({ "If-None-Match": etag });
    console.log("if-none-match", conditional.status);

    // freshness wins over an unsatisfiable range: a 304, never a 416
    const freshRange = await get({ "If-None-Match": etag, Range: "bytes=999999999-" });
    console.log("fresh with range", freshRange.status);

    // the last callback can land a tick after its response does
    await new Promise((resolve) => setTimeout(resolve, 200));
    console.log(events);
    process.exit(0);
});
