// close() drops idle keep-alive connections, as node's own close() does since 19. Without it a
// kept-alive socket went on being served while the drain waited on pending responses, so a drain
// under steady traffic never ended; the busy connection is spared until its response is done.

const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");

const express = require("../../src/index.js");

function connect(port) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
        socket.on("error", reject);
    });
}

function request(socket, path) {
    return new Promise((resolve) => {
        let data = "";
        const onData = (chunk) => {
            data += chunk;
            if (data.includes("done")) {
                socket.off("data", onData);
                resolve(data);
            }
        };
        socket.on("data", onData);
        socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`);
    });
}

test("close() drops the idle connection and spares the busy one until it finishes", async () => {
    const app = express();
    app.get("/slow", (req, res) => setTimeout(() => res.send("slow done"), 300));
    app.get("/fast", (req, res) => res.send("fast done"));
    await new Promise((resolve) => app.listen(0, resolve));
    const port = app.address().port;

    const idle = await connect(port);
    const busy = await connect(port);
    // one answered request makes it an established keep-alive socket, not a fresh accept
    await request(idle, "/fast");

    const slow = request(busy, "/slow");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const closed = new Promise((resolve) => app.close(resolve));
    const idleClosed = new Promise((resolve) => idle.once("close", resolve));

    // the drain is underway; the idle socket must be dropped, not served
    const outcome = await Promise.race([
        request(idle, "/fast").then(() => "answered"),
        idleClosed.then(() => "dropped")
    ]);
    assert.strictEqual(outcome, "dropped");

    // and the pending response still completes before the server says closed
    assert.match(await slow, /slow done/);
    await closed;

    idle.destroy();
    busy.destroy();
});
