---
description: "Serve a fulmine.js app with http.createServer(app), like Express, for supertest and other tools, on Bun and Deno, and over HTTP/2 with node:http2."
---

# Run on node:http, node:http2, Bun and Deno

The app is a request listener like Express's, so `http.createServer(app)` works, and with it supertest. Node serves those requests, not uWS: it is for compatibility, not for speed. On Bun and Deno `app.listen()` takes this path by itself.

From a clone of the repository:

```sh
cd examples && npm install
node node-http.js
```

<<< @/../examples/node-http.js

## HTTP/2

Express crashes on `node:http2`, so `http2-express-bridge` exists. Fulmine does not need it, the app is a listener for `http2.createServer` and `http2.createSecureServer` too. With `allowHTTP1: true` the same port also answers HTTP/1.1. Also here node serves the requests, not µWS: µWS has no HTTP/2.

```js
const http2 = require("node:http2");
const fs = require("node:fs");

http2
    .createSecureServer(
        { key: fs.readFileSync("server.key"), cert: fs.readFileSync("server.crt"), allowHTTP1: true },
        app
    )
    .listen(8443);
```

On HTTP/2, `:authority` is read as `Host` when the client sends no `Host`, `req.httpVersion` is `"2.0"`, and the connection headers (`Connection`, `Keep-Alive`) are not written, the protocol forbids them.

See also: [Compared with the others](/compare), [Differences from Express](/differences).
