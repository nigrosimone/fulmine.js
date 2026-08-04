// must support vhost with a whole app behind it
// INSPECT

const express = require("express");
const vhost = require("vhost");
const net = require("net");

// vhost calls what it was given, so an app has to be a function to be usable behind it. That is why
// express() returns one rather than the Application whose properties it carries, and why
// src/node-shim.js had to come first: a callable app is one supertest wraps in http.createServer,
// and without something able to serve node's IncomingMessage that wrapping hangs.
const app = express();

const api = express();
api.set("view engine", "pug");
api.get("/ping", (req, res) => res.send(`api ping, req.app is the sub app: ${req.app === api}`));
api.get("/settings", (req, res) => res.send(`view engine: ${req.app.get("view engine")}`));

const admin = express.Router();
admin.get("/ping", (req, res) => res.send("admin ping"));

app.use(vhost("api.localhost", api));
app.use(vhost("admin.localhost", admin));
app.get("/ping", (req, res) => res.send("main ping"));

// A raw socket, because Host is what vhost dispatches on and fetch refuses to set it: it is a
// forbidden header there, so every request would arrive claiming the same host.
function raw(path, host) {
    return new Promise((resolve) => {
        const client = new net.Socket();
        client.connect(13333, "127.0.0.1", () => {
            client.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
        });
        let data = "";
        client.on("data", (chunk) => (data += chunk.toString()));
        client.on("close", () => {
            const status = data.split("\r\n")[0].split(" ").slice(1).join(" ");
            const body = (data.split("\r\n\r\n")[1] || "").split("\n")[0];
            resolve(`${status}  ${JSON.stringify(body.slice(0, 60))}`);
        });
    });
}

app.listen(13333, async () => {
    const cases = [
        ["/ping", "api.localhost"],
        ["/settings", "api.localhost"],
        ["/ping", "admin.localhost"],
        ["/ping", "localhost"],
        // nothing in the sub-app answered, so vhost hands the request back to the outer chain
        ["/nowhere", "api.localhost"]
    ];

    for (const [path, host] of cases) {
        console.log(path, host, await raw(path, host));
    }

    process.exit(0);
});
