// a HEAD of a redirect must carry the Content-Length the GET body would have

const express = require("express");
const net = require("net");

async function sendRequest(method, url, arrayHeaders = []) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        const [host, port] = url.split("://")[1].split("/")[0].split(":");
        const path = "/" + url.split("/").slice(3).join("/");

        client.connect(parseInt(port), host, () => {
            let request = `${method} ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
            for (const [key, value] of arrayHeaders) {
                request += `${key}: ${value}\r\n`;
            }
            request += "Connection: close\r\n\r\n";
            client.write(request);
        });
        let data = "";
        client.on("data", (chunk) => {
            data += chunk.toString();
        });
        client.on("close", () => resolve(data));
    });
}

const app = express();

app.get("/r", (req, res) => {
    res.redirect("http://example.com");
});

app.get("/r301", (req, res) => {
    res.redirect(301, "/elsewhere");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const [method, path, accept] of [
        ["HEAD", "/r", "*/*"],
        ["HEAD", "/r301", "*/*"],
        ["HEAD", "/r", "text/html"],
        ["GET", "/r", "*/*"]
    ]) {
        const response = await sendRequest(method, `http://localhost:13333${path}`, [["Accept", accept]]);
        const status = response.split("\r\n")[0].split(" ")[1];
        const contentLength = (response.match(/Content-Length: (\d+)/i) || [])[1];
        const location = (response.match(/Location: ([^\r\n]+)/i) || [])[1];
        const body = response.split("\r\n\r\n")[1] || "";
        console.log([method, path, accept, status, contentLength, location, body.length]);
    }
    process.exit(0);
});
