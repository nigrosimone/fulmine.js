---
description: "See which routes uWebSockets.js matches in C++ and which are answered without JavaScript, and fail a test when one falls off the fast path."
---

# Keep a route on the fast path

A route that stops being eligible for the fast path still answers right, only slower, and nothing complains. `express.testing` lets a test assert what `listen()` decided, and `npx fulmine.js profile` prints the same for a human.

From a clone of the repository:

```sh
cd examples && npm install
node fast-routes.js
```

<<< @/../examples/fast-routes.js

See also: [Performance](/performance).
