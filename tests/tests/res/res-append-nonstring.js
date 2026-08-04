// res.append() and res.setHeader() turn non-string values into text before they reach the wire
// INSPECT

const net = require("net");
const express = require("express");

// fetch combines repeated headers, so the raw lines are read off a socket
async function sendRequest(method, url) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        const [host, port] = url.split("://")[1].split("/")[0].split(":");
        const path = "/" + url.split("/").slice(3).join("/");

        client.connect(parseInt(port), host, () => {
            client.write(`${method} ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
        });
        let data = "";
        client.on("data", (chunk) => {
            data += chunk.toString();
        });
        client.on("close", () => resolve(data));
    });
}

const app = express();

app.get("/numbers", (req, res) => {
    // computed, so the route takes the ordinary response path rather than the declarative compiler
    const n = 41 + 1;
    res.append("X-Num", n);
    res.append("X-Num", n + 1);
    res.send("ok");
});

app.get("/array", (req, res) => {
    res.setHeader("X-Arr", [1, 2]);
    res.send("ok");
});

app.get("/mixed", (req, res) => {
    const start = Date.now() - Date.now(); // 0, computed
    res.append("X-Timing", start);
    res.append("X-Timing", "later");
    res.send("ok");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/numbers", "/array", "/mixed"]) {
        const response = await sendRequest("GET", `http://localhost:13333${path}`);
        console.log(
            path,
            response
                .split("\r\n")
                .map((line) => line.toLowerCase().trim())
                // not x-powered-by: fulmine leaves it off by default, which is documented
                .filter((line) => line.startsWith("x-") && !line.startsWith("x-powered-by"))
                .sort((a, b) => a.localeCompare(b))
        );
    }
    process.exit(0);
});
