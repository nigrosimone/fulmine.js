---
description: 'Split a database pool across the workers of express({ cluster: "auto" }) with app.cluster.share(), so all the processes together never open more connections than the database allows.'
---

# A database pool per cluster worker

With `express({ cluster: "auto" })` every worker is its own process and opens its own pool. Give each one `app.cluster.share(total)` connections and together they never go over what the database allows: 40 over 6 workers is 7, 7, 7, 7, 6, 6. `app.cluster` also tells how many workers serve, the index of this one, and `serves`, false only in the primary, which only forks: open no pool there. A worker that dies is replaced in the same place.

From a clone of the repository:

```sh
cd examples && npm install
node cluster-pool.js
```

<<< @/../examples/cluster-pool.js

See also: [One process per core on one port](/examples/cluster), [Performance](/performance).
