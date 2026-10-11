---
description: 'Run an Express app on every CPU core, all on the same port, with no primary process in the path: express({ cluster: "auto" }).'
---

# One process per core on one port

`express({ cluster: "auto" })` forks one worker per core and each binds the same port with `SO_REUSEPORT`. The kernel spreads the connections, the primary does not pass them over IPC like node's `cluster` does.

From a clone of the repository:

```sh
cd examples && npm install
node cluster.js
```

<<< @/../examples/cluster.js

See also: [Performance](/performance), [Deploying](/deployment).
