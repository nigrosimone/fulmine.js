// a HEAD with a Range must answer 206 with the Content-Length of the selected part

const express = require("express");
const path = require("path");
const net = require("net");

async function sendRequest(method, url, arrayHeaders) {
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

app.get("/test", (req, res) => {
    res.sendFile(path.join(process.cwd(), "src/index.js"));
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const range of ["bytes=0-99", "bytes=100-199", "bytes=0-"]) {
        const response = await sendRequest("HEAD", "http://localhost:13333/test", [["Range", range]]);
        const status = response.split("\r\n")[0].split(" ")[1];
        const contentLength = (response.match(/Content-Length: (\d+)/i) || [])[1];
        const contentRange = (response.match(/Content-Range: ([^\r\n]+)/i) || [])[1];
        const body = response.split("\r\n\r\n")[1] || "";
        console.log([range, status, contentLength, contentRange, body.length]);
    }
    process.exit(0);
});
