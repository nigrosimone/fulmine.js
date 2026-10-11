---
description: "Serve a fulmine.js app with http.createServer(app), like Express, for supertest and other tools, and on Bun and Deno."
---

# Run on node:http, Bun and Deno

The app is a request listener like Express's, so `http.createServer(app)` works, and with it supertest. Node serves those requests, not uWS: it is for compatibility, not for speed. On Bun and Deno `app.listen()` takes this path by itself.

From a clone of the repository:

```sh
cd examples && npm install
node node-http.js
```

<<< @/../examples/node-http.js

See also: [Compared with the others](/compare), [Differences from Express](/differences).
