---
description: "Built-in response compression for an Express app: express.compression() takes the options of the compression module."
---

# Compression without the compression package

`express.compression()` takes the same options as the `compression` module and decides the same way. A response that arrives whole is compressed in one call and goes out with a Content-Length.

From a clone of the repository:

```sh
cd examples && npm install
node compression.js
```

<<< @/../examples/compression.js

See also: [Performance](/performance).
