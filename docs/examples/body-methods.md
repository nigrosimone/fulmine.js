---
description: 'Read a request body on DELETE or other methods with app.set("body methods", ["DELETE"]), since fulmine.js reads one only for POST, PUT, PATCH and QUERY.'
---

# DELETE with a JSON body

Express reads a body on any method, fulmine by default only on POST, PUT, PATCH and QUERY, because reading one nobody asks for costs about 15%. An API that sends a body with DELETE names it in `body methods`.

From a clone of the repository:

```sh
cd examples && npm install
node body-methods.js
```

<<< @/../examples/body-methods.js

See also: [Differences from Express](/differences), [Compatibility](/compatibility).
