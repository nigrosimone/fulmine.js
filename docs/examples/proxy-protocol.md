---
description: 'Read the real client address from the PROXY protocol v2 preamble with app.set("trust proxy protocol", true), or from X-Forwarded-For with trust proxy.'
---

# Client IP behind HAProxy, AWS NLB, nginx or Envoy

`trust proxy` works as in Express. `trust proxy protocol` is the other way: the proxy prepends a PROXY protocol v2 preamble and `req.ip` comes from it, with no header at all. It is off by default, read why before turning it on.

From a clone of the repository:

```sh
cd examples && npm install
node proxy-protocol.js
```

<<< @/../examples/proxy-protocol.js

See also: [Behind a proxy](/deployment#behind-a-proxy).
