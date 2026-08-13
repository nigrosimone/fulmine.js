// Being told the client's address by a proxy, both ways round.
//
// "trust proxy" is Express's and works as it does there: req.ip, req.ips, req.protocol and
// req.hostname are read from X-Forwarded-* when the connection comes from a peer you trust.
//
// "trust proxy protocol" is this project's own, and is the way that uses no headers at all.
// HAProxy, AWS NLB, nginx with proxy_protocol and Envoy can prepend a PROXY protocol preamble to
// the connection, and uWS parses it. It is the binary v2 preamble that is read, not the v1 text
// line: a connection that starts with "PROXY TCP4 ..." is answered as a malformed request.
//
//   node proxy-protocol.js
//   node proxy-protocol.js --client    (in another terminal: asks twice, with and without one)
const express = require("fulmine.js"); // instead of require("express")
const net = require("net");

if (process.argv.includes("--client")) {
    ask(true).then(() => ask(false));
    return;
}

const app = express();

app.set("trust proxy", "loopback");

// WARNING: only turn this on when nothing but the proxy can reach the server. uWS reads the
// preamble from whoever sends it, and there is no way to say which peers may use it, so on a port
// open to the internet the first sixteen bytes of any connection are enough for a client to become
// 203.0.113.7 for your rate limiter, your allow list and your audit log. Bind to the private
// interface, or keep this off.
app.set("trust proxy protocol", true);

app.get("/", (req, res) => {
    // the preamble decides what the connection's address is, and "trust proxy" then peels
    // X-Forwarded-For off that, so a proxy that sends both is read the way it meant. A connection
    // that sent no preamble falls back to the socket's own address
    res.json({ ip: req.ip, ips: req.ips, protocol: req.protocol, socket: req.socket.remoteAddress });
});

app.listen(3000, "127.0.0.1", () => console.log("http://127.0.0.1:3000"));

/**
 * What a load balancer writes before the request: PROXY protocol v2 over TCP/IPv4, declaring
 * 203.0.113.7:4321 -> 10.0.0.1:80. No client library writes this, so the example does it by hand.
 *
 * @returns {Buffer}
 */
function preamble() {
    const signature = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
    // 0x21: version 2, command PROXY. 0x11: AF_INET over STREAM. Then the length of what follows
    const meta = Buffer.from([0x21, 0x11, 0x00, 0x0c]);
    const addresses = Buffer.from([203, 0, 113, 7, 10, 0, 0, 1, 0x10, 0xe1, 0x00, 0x50]);
    return Buffer.concat([signature, meta, addresses]);
}

/**
 * One request over a raw socket, since no http client can be made to write a preamble first.
 *
 * @param {boolean} withPreamble
 * @returns {Promise<void>}
 */
function ask(withPreamble) {
    return new Promise((resolve) => {
        const socket = net.connect(3000, "127.0.0.1", () => {
            if (withPreamble) socket.write(preamble());
            socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
        });
        let received = "";
        socket.on("data", (chunk) => (received += chunk));
        socket.on("close", () => {
            console.log(`${withPreamble ? "with" : "without"} a preamble:`, received.split("\r\n\r\n")[1]);
            resolve();
        });
    });
}
