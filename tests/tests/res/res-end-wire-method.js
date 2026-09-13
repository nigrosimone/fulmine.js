// res.end() sends a body, or not, by the method that arrived and not by what req.method reads later

const express = require("express");
const http = require("http");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// what method-override does. node settles whether a body goes out when the request arrives, so a
// GET made a HEAD still answers with its body, and a HEAD made a GET still answers without one
app.use("/get-made-head", (req, res, next) => {
    if (req.method === "GET") req.method = "HEAD";
    next();
});
app.get("/get-made-head", (req, res) => res.end("body of a get made head"));

app.use("/head-made-get", (req, res, next) => {
    if (req.method === "HEAD") req.method = "GET";
    next();
});
app.get("/head-made-get", (req, res) => res.end("body of a head made get"));

app.get("/plain", (req, res) => res.end("plain body"));

// send() and json() are the other way round: express reads req.method there, at send time, so a
// GET made a HEAD answers with the length of the body and none of it. node then frames what it is
// handed and the client waits for a body that never comes, which is why these are read with a
// client that stops at the head: the answer is the head, the hang is the same on both
app.use("/send-made-head", (req, res, next) => {
    if (req.method === "GET") req.method = "HEAD";
    next();
});
app.get("/send-made-head", (req, res) => res.send("sent after rewrite"));
app.get("/json-made-head", (req, res, next) => {
    req.method = "HEAD";
    next();
});
app.get("/json-made-head", (req, res) => res.json([1, "two", null]));
app.get("/send-plain", (req, res) => res.send("sent plainly"));

/**
 * The status, the length the head declares and how many body bytes followed it within a moment:
 * node's client would wait for the declared length, and what arrived by then is the answer
 */
const headOf = (method, path) =>
    new Promise((resolve, reject) => {
        const request = http.request("http://localhost:13333" + path, { method }, (res) => {
            let bytes = 0;
            res.on("data", (chunk) => (bytes += chunk.length));
            setTimeout(() => {
                res.destroy();
                resolve(`${res.statusCode} content-length: ${res.headers["content-length"]} body bytes: ${bytes}`);
            }, 500);
        });
        request.on("error", reject);
        request.end();
    });

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(
        [
            ["GET", "/get-made-head"],
            ["HEAD", "/get-made-head"],
            ["HEAD", "/head-made-get"],
            ["GET", "/head-made-get"],
            ["HEAD", "/plain"],
            ["GET", "/plain"]
        ].map(([method, path]) => async () => {
            // bounded: without the fix the answer never completes, and a hang is a worse red than a line
            const res = await fetchTest("http://localhost:13333" + path, { method, signal: AbortSignal.timeout(5000) });
            const body = await res.text();
            console.log(method, path, res.status, JSON.stringify(body));
        })
    );
    for (const [method, path] of [
        ["GET", "/send-made-head"],
        ["GET", "/json-made-head"],
        ["HEAD", "/send-plain"],
        ["GET", "/send-plain"]
    ]) {
        console.log(method, path, await headOf(method, path));
    }
    process.exit(0);
});
