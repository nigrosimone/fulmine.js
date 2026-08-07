// The PROXY protocol, and the reason it is off by default.
//
// µWS parses the v2 preamble from whoever sends it. There is no listen option asking for it and no
// way to say which peers may use it, so the preamble below is one any client can send: these tests
// send it from an ordinary socket, which is exactly the attack the setting has to be opt-in against.
// With the setting off the declared address must be ignored, with it on it must be believed, and a
// connection that sends no preamble must read the same either way.

const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");

const express = require("../../src/index.js");

/** PROXY protocol v2 over TCP/IPv4: 203.0.113.7:4321 -> 10.0.0.1:80 */
function preambleV2() {
    const signature = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
    // 0x21: version 2, command PROXY. 0x11: AF_INET over STREAM. Then the length of what follows
    const meta = Buffer.from([0x21, 0x11, 0x00, 0x0c]);
    const addresses = Buffer.from([203, 0, 113, 7, 10, 0, 0, 1, 0x10, 0xe1, 0x00, 0x50]);
    return Buffer.concat([signature, meta, addresses]);
}

/**
 * Asks over a raw socket, since fetch cannot be made to write a preamble first.
 *
 * @param {number} port
 * @param {boolean} withPreamble
 * @param {string} [path]
 * @returns {Promise<string>} the response body
 */
function ask(port, withPreamble, path = "/ip") {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
            if (withPreamble) socket.write(preambleV2());
            socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        });
        let received = "";
        socket.on("data", (chunk) => (received += chunk));
        socket.on("close", () => resolve(received.slice(received.indexOf("\r\n\r\n") + 4)));
        socket.on("error", reject);
    });
}

/**
 * @param {boolean} trusted what "trust proxy protocol" is set to
 * @returns {Promise<{port: number, close: () => void}>}
 */
function serve(trusted) {
    return new Promise((resolve) => {
        const app = express();
        app.set("trust proxy protocol", trusted);
        app.get("/ip", (req, res) => res.send(String(req.ip)));
        app.listen(0, () => resolve({ port: app.address().port, close: () => app.close() }));
    });
}

test("the address a proxy declares is ignored unless the application asked for it", async () => {
    const { port, close } = await serve(false);
    try {
        // the same preamble a load balancer would send, from a client that is not one
        assert.equal(await ask(port, true), "::ffff:127.0.0.1");
        assert.equal(await ask(port, false), "::ffff:127.0.0.1");
    } finally {
        close();
    }
});

test("with the setting on, req.ip is the address the preamble carried", async () => {
    const { port, close } = await serve(true);
    try {
        // plain, not ::ffff:203.0.113.7: the mapped form belongs to the dual stack socket, and this
        // address never came through one
        assert.equal(await ask(port, true), "203.0.113.7");
        // and a connection with no preamble still reads its own address rather than an empty one
        assert.equal(await ask(port, false), "::ffff:127.0.0.1");
    } finally {
        close();
    }
});

test("everything that reads the peer address follows req.ip", async () => {
    const app = express();
    app.set("trust proxy protocol", true);
    app.get("/all", (req, res) => {
        res.json({
            ip: req.ip,
            socket: req.socket.remoteAddress,
            connection: req.connection.remoteAddress,
            // "trust proxy" peels X-Forwarded-For off the address it now sees, which is the client
            ips: req.ips
        });
    });
    const port = await new Promise((resolve) => app.listen(0, () => resolve(app.address().port)));
    try {
        const body = await ask(port, true, "/all");
        assert.deepEqual(JSON.parse(body), {
            ip: "203.0.113.7",
            socket: "203.0.113.7",
            connection: "203.0.113.7",
            ips: []
        });
    } finally {
        app.close();
    }
});
