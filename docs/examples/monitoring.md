---
description: "Subscribe to the express.router.request TracingChannel and node's http.server channels to trace every middleware and handler, also on uWebSockets.js."
---

# Trace requests with diagnostics_channel

Fulmine publishes the channels Express and node publish, also when uWS serves the request: `express.router.request` for every middleware and handler, and node's `http.server.*`. Subscribe before `listen()`.

From a clone of the repository:

```sh
cd examples && npm install
node monitoring.js
```

<<< @/../examples/monitoring.js

See also: [Monitoring](/monitoring).
