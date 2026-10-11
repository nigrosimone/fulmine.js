---
description: "Use socket.io with an Express-compatible app on uWebSockets.js, through io.attachApp(app.uwsApp)."
---

# socket.io on uWebSockets.js

There is no node `http.Server` for socket.io to take the upgrade from, so it is attached to the uWS app with `io.attachApp(app.uwsApp)`, which socket.io supports natively.

From a clone of the repository:

```sh
cd examples && npm install
node socket-io.js
```

<<< @/../examples/socket-io.js

See also: [WebSockets](/websockets#socket-io).
