// a Range request must be answered on a route that reaches sendFile through res.status()
// (no INSPECT: the middleware it mounts reads headers, and the skip this covers is never granted)

// The header skip trusts a handler whose every member of res is one that reads no request header.
// sendFile is not one, and a chained res.status(200).sendFile() hid it: the member was read off
// the call, not off res, and the skip was granted. The Range header then never reached sendFile.

const express = require("express");
const path = require("path");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);
const file = path.join(process.cwd(), "src/index.js");

app.get("/chained", (req, res) => {
    res.status(200).sendFile(file);
});
app.get("/plain", (req, res) => {
    res.sendFile(file);
});
app.get("/redirect", (req, res) => {
    res.set("x-a", "b").redirect("/plain");
});

const PORT = 13333;

app.listen(PORT, async () => {
    const answers = await sequential([
        () => fetchTest(`http://localhost:${PORT}/chained`, { headers: { range: "bytes=0-9" } }),
        () => fetchTest(`http://localhost:${PORT}/plain`, { headers: { range: "bytes=0-9" } }),
        // redirect negotiates the body on Accept, which the skip would not have read
        () => fetchTest(`http://localhost:${PORT}/redirect`, { redirect: "manual", headers: { accept: "text/html" } })
    ]);
    for (const answer of answers) {
        const body = await answer.text();
        console.log(answer.status, answer.headers.get("content-range"), body.length, JSON.stringify(body.slice(0, 40)));
    }
    process.exit(0);
});
