// express.static serves an in-root ".." path, since send normalizes before refusing traversal

const express = require("express");
const net = require("net");
const path = require("path");

// fetch normalizes dot segments away before sending, so the raw path goes over a socket
async function sendRequest(reqPath) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        client.connect(13333, "localhost", () => {
            client.write(`GET ${reqPath} HTTP/1.1\r\nHost: localhost:13333\r\nConnection: close\r\n\r\n`);
        });
        let data = "";
        client.on("data", (chunk) => {
            data += chunk.toString();
        });
        client.on("close", () => resolve(data));
    });
}

const app = express();

// root is tests/, and "sub" need not exist: the ".." is collapsed lexically before any stat
app.use("/static", express.static(path.join(process.cwd(), "tests")));
app.use("/strict", express.static(path.join(process.cwd(), "tests"), { fallthrough: false }));

app.use((err, req, res, next) => {
    res.status(err.status || 500).send(`error: ${err.status || 500}`);
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        "/static/sub/../parts/small-file.json", // in-root, must serve
        "/strict/sub/../parts/small-file.json", // in-root, must serve
        "/static/../package.json", // escapes the root, must not serve
        "/strict/../package.json" // escapes the root, refused
    ];
    for (const reqPath of paths) {
        const response = await sendRequest(reqPath);
        const status = response.split("\r\n")[0].split(" ")[1];
        const body = (response.split("\r\n\r\n")[1] || "").trim();
        console.log([reqPath, status, body.slice(0, 30).replace(/\s+/g, " ")]);
    }
    process.exit(0);
});
