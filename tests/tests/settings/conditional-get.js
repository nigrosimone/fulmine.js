// must answer a conditional GET in full when "conditional get" is off

const express = require("express");
const http = require("node:http");

const app = express();

// "conditional get" is this project's own, so Express ignores it and still answers 304. What is
// compared is this file's own answers, which both servers must print alike
const isFulmine = express.isFulmine === true;
app.set("conditional get", false);
app.set("etag", false);

// reads no header, so only the headers that steer the framework are read
app.get("/no-headers", (req, res) => {
    const body = ["o", "k"].join("");
    res.send(body);
});
// reads one, so every header is copied
app.get("/headers", (req, res) => {
    res.send(req.get("x-test") ?? "none");
});
app.get("/last-modified", (req, res) => {
    res.set("Last-Modified", new Date(0).toUTCString());
    res.send(["o", "k"].join(""));
});
app.get("/fresh", (req, res) => {
    res.end(String(req.fresh));
});

// fetch adds Cache-Control: no-cache to a conditional request, and no-cache is never fresh
function get(path, headers) {
    return new Promise((resolve, reject) => {
        http.get({ port: 13333, path, headers }, (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => resolve({ status: res.statusCode, body }));
        }).on("error", reject);
    });
}

app.listen(13333, async () => {
    for (const path of ["/no-headers", "/headers", "/fresh"]) {
        const response = await get(path, { "if-none-match": "*" });
        const body = response.body;
        const expected = isFulmine ? 200 : path === "/fresh" ? 200 : 304;
        console.log(`${path} with If-None-Match *:`, response.status === expected);
        if (path === "/fresh") {
            console.log("req.fresh:", body === String(!isFulmine));
        }
    }

    const modified = await get("/last-modified", { "if-modified-since": new Date().toUTCString() });
    console.log("/last-modified with If-Modified-Since:", modified.status === (isFulmine ? 200 : 304));

    process.exit(0);
});
