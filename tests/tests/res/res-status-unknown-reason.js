// a status code without a registered message goes out with the reason phrase "unknown", as node writes it

const express = require("express");
const net = require("net");

async function sendRequest(path) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        client.connect(13333, "localhost", () => {
            client.write(`GET ${path} HTTP/1.1\r\nHost: localhost:13333\r\nConnection: close\r\n\r\n`);
        });
        let data = "";
        client.on("data", (chunk) => {
            data += chunk.toString();
        });
        client.on("close", () => resolve(data));
    });
}

const app = express();

app.get("/send", (req, res) => {
    // computed, so the route takes the ordinary response path rather than the declarative compiler
    const code = 578 + 1;
    res.status(code).send("x");
});

app.get("/chunked", (req, res) => {
    // the chunked path writes its own status line
    res.status(579);
    res.write("a");
    res.end();
});

app.get("/known", (req, res) => {
    const code = 417 + 1;
    res.status(code).send("teapot");
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/send", "/chunked", "/known"]) {
        const response = await sendRequest(path);
        console.log(path, response.split("\r\n")[0]);
    }
    process.exit(0);
});
