---
description: "Add a Server-Timing header that says how each request was routed and how long it took, visible in the browser dev tools: express.serverTiming()."
---

# See how a request was routed in Server-Timing

`express.serverTiming()` writes a Server-Timing header: how the request was routed, what it had to build, and your own marks with `res.time()` and `res.timing()`. The browser shows it in the network panel.

From a clone of the repository:

```sh
cd examples && npm install
node server-timing.js
```

<<< @/../examples/server-timing.js

See also: [Performance](/performance), [Monitoring](/monitoring).
