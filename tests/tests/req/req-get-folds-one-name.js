// req.get folds a repeated header as req.headers does, without building it: joined with ", ",
// cookie with "; ", the first value only where node discards duplicates

const net = require("net");
const express = require("express");

// raw socket, because fetch folds the repeats itself
function sendRequest(path, arrayHeaders) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        let data = "";
        client.connect(13333, "localhost", () => {
            let request = `GET ${path} HTTP/1.1\r\nHost: localhost:13333\r\nConnection: close\r\n`;
            for (const [key, value] of arrayHeaders) {
                request += `${key}: ${value}\r\n`;
            }
            client.write(request + "\r\n");
        });
        client.on("data", (chunk) => (data += chunk));
        client.on("close", () => resolve(data));
    });
}

// set-cookie last, it builds req.headers
const NAMES = ["constructor", "x-dup", "X-DUP", "cookie", "user-agent", "referrer", "referer", "missing", "set-cookie"];

const app = express();
app.get("/get", (req, res) => {
    for (const name of NAMES) {
        console.log(name, JSON.stringify(String(req.get(name))));
    }
    res.send("ok");
});
app.get("/late", (req, res) => {
    req.headers["x-late"] = "set";
    console.log("x-late", JSON.stringify(req.get("x-late")), JSON.stringify(req.get("x-dup")));
    res.send("ok");
});

app.listen(13333, async () => {
    const headers = [
        ["X-Dup", "a"],
        ["X-Dup", "b"],
        ["Cookie", "a=1"],
        ["Cookie", "b=2"],
        ["User-Agent", "first"],
        ["User-Agent", "second"],
        ["Referer", "http://x/"],
        ["Referrer", "http://r/"],
        ["Set-Cookie", "c=3"],
        ["Set-Cookie", "d=4"]
    ];
    for (const path of ["/get", "/late"]) {
        const response = await sendRequest(path, headers);
        console.log(path, response.split("\r\n")[0]);
    }
    process.exit(0);
});
