# WebSockets

`app.ws()` registers a WebSocket route, served by µWS itself. The upgrade never reaches node, so `server.on("upgrade")` and the libraries built on it have nothing to hear; this is the replacement.

```js
app.ws("/room/:id", {
    upgrade(req, res) {
        // runs before the handshake, with a real request and response.
        // Answering the response declines the socket:
        if (!req.query.token) return res.sendStatus(401);
        // and anything left on the request is there for the socket's whole life:
        req.room = req.params.id;
    },
    open(ws) {
        ws.subscribe(ws.req.room);
    },
    message(ws, message, isBinary) {
        ws.publish(ws.req.room, message, isBinary);
    },
    close(ws, code, message) {}
});
```

- **The behavior object is µWS's**, settings included: `maxPayloadLength`, `idleTimeout`, `compression`, `maxBackpressure`, `sendPingsAutomatically` and the rest are passed through untouched, as are the `open`, `message`, `drain`, `close`, `ping`, `pong`, `dropped` and `subscription` handlers. The socket is µWS's too, so `send`, `subscribe`, `publish`, `cork` and `getBufferedAmount` behave exactly as its documentation describes.
- **`upgrade(req, res)` is this project's addition.** It runs before the handshake with the same `Request` and `Response` your routes get, so a session, a token or a header decides whether the socket opens. Answering the response, with `res.sendStatus(401)` or any other write, declines the upgrade. Returning a promise holds the handshake until it settles, which is what an authentication lookup needs.
- **`ws.req` is that request**, and it outlives the response: the client's address, headers, query and params are readable from any handler for as long as the socket is open. Hanging your own values on it in `upgrade` is how per-connection state gets to `message`.
- **A hook that awaits can be left holding a dead request.** The client may go while a token is being checked, and µWS frees the response when it does, so `res.aborted` says whether there is still anybody to answer. Writing to a response that was aborted does nothing rather than throwing.
- **Routers work.** `router.ws("/lobby", ...)` mounted with `app.use("/chat", router)` serves `/chat/lobby`.
- **Paths are the ones µWS matches**: literal, or with parameters that are a whole segment such as `/room/:id`. Anything else throws where it is written rather than failing to match later.
- **Broadcasting from outside a socket**: `app.publish(topic, message)` and `app.numSubscribers(topic)`.

A WebSocket route and an ordinary route can share a path: the upgrade goes to the WebSocket route, a plain GET goes through normal routing. Runnable, with a page that opens the socket: [`examples/websocket.js`](../examples/websocket.js).

If you would rather use the `ws` module's API, [Ultimate WS](https://github.com/dimdenGD/ultimate-ws) is a drop-in replacement for it written against Ultimate Express, and Fulmine still exposes the mechanism it hooks into, but that combination is not covered by this project's tests. `app.uwsApp` also remains available for anything µWS offers that this does not.

## socket.io

socket.io normally takes over the upgrade on a node `http.Server`. The upgrade here never reaches
node, so hand it the µWS app instead, which socket.io supports natively through `attachApp()`:

```js
const express = require("fulmine.js");
const { Server } = require("socket.io");

const app = express();
const io = new Server();

app.listen(3000);
io.attachApp(app.uwsApp);

io.on("connection", (socket) => {
    socket.on("message", (data) => socket.emit("reply", data));
});
```

`attachApp()` works before or after `app.listen()`. What does not work is `new Server(app)` on the
app itself, or on what `app.listen()` returns, which is the same object: socket.io refuses it with
"You are trying to attach socket.io to an express request handler function", because it checks for a
function before it checks for a server, and an app here is callable. That refusal is the useful
answer. Even if it accepted the object, there is no node socket behind it to take an upgrade over,
so it would have failed later and more quietly. Plain HTTP keeps serving either way. This is covered
by `tests/tests/middlewares/socket-io.js`, which runs the same file against Express and against
Fulmine and compares the output. Runnable: [`examples/socket-io.js`](../examples/socket-io.js).
