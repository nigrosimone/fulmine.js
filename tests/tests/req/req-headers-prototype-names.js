// req.headers keeps a null prototype: a header named after an Object.prototype member is an
// INSPECT
// ordinary header, and a duplicate whose first value is empty still folds the way node folds it

const net = require("net");
const express = require("express");

// raw socket, because fetch refuses to send duplicate or empty header values
function sendRequest(path, arrayHeaders) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        let data = "";
        client.connect(13333, "localhost", () => {
            let request = `GET ${path} HTTP/1.1\r\n`;
            request += "Host: localhost:13333\r\n";
            request += "Connection: close\r\n";
            for (const [key, value] of arrayHeaders) {
                request += `${key}: ${value}\r\n`;
            }
            request += "\r\n";
            client.write(request);
        });
        client.on("data", (chunk) => (data += chunk));
        client.on("close", () => resolve(data));
    });
}

const app = express();

app.get("/test", (req, res) => {
    console.log("constructor:", String(req.headers.constructor));
    console.log("x-dup:", JSON.stringify(req.headers["x-dup"]));
    console.log("distinct constructor:", JSON.stringify(req.headersDistinct.constructor));
    console.log("distinct x-dup:", JSON.stringify(req.headersDistinct["x-dup"]));
    res.send("ok");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const response = await sendRequest("/test", [
        ["Constructor", "foo"],
        ["X-Dup", ""],
        ["X-Dup", "b"]
    ]);
    console.log("status:", response.split("\r\n")[0]);

    process.exit(0);
});
