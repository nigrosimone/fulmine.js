---
description: "Serve an Express-compatible app over HTTPS by passing the certificate to express({ uwsOptions })."
---

# HTTPS without https.createServer

There is no node server to give a certificate to, so TLS is configured in `express({ uwsOptions })` and uWebSockets.js serves it.

From a clone of the repository:

```sh
cd examples && npm install
node https.js
```

<<< @/../examples/https.js

See also: [Differences from Express](/differences).
