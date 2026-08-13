// app.ws(): a WebSocket route served by uWS itself. The upgrade never reaches node, so
// server.on("upgrade") and the libraries built on it have nothing to hear, and this is what
// replaces them. The behavior object is uWS's, with one addition of this project's own.
//
//   node websocket.js   ->  http://localhost:3000  (the page opens the socket)
const express = require("fulmine.js"); // instead of require("express")

const app = express();

app.ws("/room/:id", {
    // uWS's own settings, passed through untouched
    idleTimeout: 120,
    maxPayloadLength: 4 * 1024,

    // this project's addition: it runs before the handshake with the request and response an
    // ordinary route gets, so a token, a session or a header decides whether the socket opens.
    // Answering the response declines the upgrade, and returning a promise holds the handshake
    // until it settles, which is what an authentication lookup needs
    upgrade(req, res) {
        if (!/^[a-z0-9-]{1,24}$/.test(req.params.id)) {
            return res.sendStatus(400);
        }
        // anything left on the request is there for the socket's whole life, as ws.req
        req.topic = `room:${req.params.id}`;
    },

    open(ws) {
        ws.subscribe(ws.req.topic);
        ws.send(`you are in ${ws.req.params.id}, ${app.numSubscribers(ws.req.topic)} here`);
    },

    message(ws, message, isBinary) {
        app.publish(ws.req.topic, message, isBinary);
    },

    close(ws, code, message) {
        console.log(`left ${ws.req.params.id}`);
    }
});

// broadcasting from outside a socket, which is what app.publish is for
setInterval(() => app.publish("room:lobby", `it is ${new Date().toISOString()}`), 10_000).unref();

// a WebSocket route and an ordinary route can share a path: the upgrade goes to the first, a
// plain GET goes through normal routing
app.get("/", (req, res) => {
    res.type("html").send(`<!doctype html>
<meta charset="utf-8"><title>app.ws()</title>
<pre id="log"></pre>
<script>
  const ws = new WebSocket(location.origin.replace("http", "ws") + "/room/lobby");
  ws.onmessage = (e) => (log.textContent += e.data + "\\n");
  ws.onopen = () => ws.send("hello from the browser");
</script>`);
});

app.listen(3000, () => console.log("http://localhost:3000"));
