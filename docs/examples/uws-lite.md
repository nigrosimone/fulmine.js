---
description: "A lite route with app.uwsLite in an Express app: an (req, res) handler served by uWebSockets.js, with body, middleware and streams."
---

# A lite route next to your Express routes

`app.uwsLite` is a route served by uWebSockets.js with an `(req, res)` handler: the part of Express most routes use, over two small objects. The same handler works on `app.get()`, so a route that needs more changes one word.

From a clone of the repository:

```sh
cd examples && npm install
node uws-lite.js
```

<<< @/../examples/uws-lite.js

See also: [Lite routes](/uws-routes#lite-routes-app-uwslite).
