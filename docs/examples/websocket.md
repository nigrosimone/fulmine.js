---
description: "Native WebSocket routes with app.ws() in an Express app, with an upgrade hook to check auth before the socket opens."
---

# WebSockets next to your Express routes

`app.ws()` is a WebSocket route served by uWebSockets.js, in the same app as the HTTP routes. The `upgrade(req, res)` hook decides if the socket opens, for example after checking a token.

From a clone of the repository:

```sh
cd examples && npm install
node websocket.js
```

<<< @/../examples/websocket.js

See also: [WebSockets](/websockets).
