---
description: "Serve pre-compressed brotli and gzip files from express.static with preCompressed: true, with no compression at request time."
---

# Serve the .br and .gz files your build wrote

If the build already writes `style.css.br` and `style.css.gz`, `express.static(dir, { preCompressed: true })` sends them to the clients that accept them. Nothing is compressed per request, and it costs one stat like the plain file.

From a clone of the repository:

```sh
cd examples && npm install
node static-precompressed.js
```

<<< @/../examples/static-precompressed.js

See also: [Performance](/performance).
