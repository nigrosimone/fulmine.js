---
description: "A raw uWebSockets.js route with app.uws() in an Express app: µWS's own (res, req), no middleware, no Express layer."
---

# A raw µWS route next to your Express routes

`app.uws()` is a route served by uWebSockets.js with the handler as you wrote it: µWS's own `HttpResponse` and `HttpRequest`, with nothing of Express in front. The rest of the app stays Express.

From a clone of the repository:

```sh
cd examples && npm install
node uws-route.js
```

<<< @/../examples/uws-route.js

See also: [Raw µWS routes](/uws-routes).
