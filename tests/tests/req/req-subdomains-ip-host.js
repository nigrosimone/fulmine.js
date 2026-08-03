// must treat an IP host as a single label in req.subdomains

const net = require("net");
const express = require("express");

async function sendRequest(port, host) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        client.on("data", () => client.end());
        client.on("end", resolve);
        client.connect(port, "127.0.0.1", () => {
            client.write(`GET /test HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
        });
    });
}

const app = express();
app.set("subdomain offset", 0);

// default offset of 2 must still drop an IP host entirely
const app2 = express();

app.get("/test", (req, res) => {
    console.log(JSON.stringify(req.subdomains));
    res.send("ok");
});
app2.get("/test", (req, res) => {
    console.log(JSON.stringify(req.subdomains));
    res.send("ok");
});

app.listen(13333, () => {
    app2.listen(13334, async () => {
        await sendRequest(13333, "127.0.0.1");
        await sendRequest(13333, "[::1]");
        await sendRequest(13333, "tobi.ferrets.example.com");
        await sendRequest(13334, "127.0.0.1");
        await sendRequest(13334, "tobi.ferrets.example.com");

        process.exit(0);
    });
});
