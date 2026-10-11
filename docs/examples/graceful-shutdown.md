---
description: "Close an Express-compatible app gracefully: app.listen() returns an object that answers as an http.Server for shutdown wrappers."
---

# Graceful shutdown

`app.listen()` returns the app, and it answers as an `http.Server`: `close()`, `getConnections()` and the rest that the graceful shutdown libraries look for.

From a clone of the repository:

```sh
cd examples && npm install
node graceful-shutdown.js
```

<<< @/../examples/graceful-shutdown.js

See also: [Differences from Express](/differences).
