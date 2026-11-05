---
description: Register a raw uWebSockets.js route in a Fulmine.js app with app.uws(): the handler gets µWS's own HttpResponse and HttpRequest, with no Express layer in front.
---

# Raw µWS routes

`app.uws()` registers a route that µWS serves by itself, with the handler exactly as you wrote it. It is called as `(res, req)` with µWS's own `HttpResponse` and `HttpRequest`, the way a bare µWebSockets.js application would call it: nothing of Express runs in front of it, and nothing is built for it.

```js
const express = require("fulmine.js");
const app = express();

app.uws("get", "/health", (res) => {
    res.end("ok");
});

app.uws("get", "/users/:id", (res, req) => {
    res.writeStatus("200 OK")
        .writeHeader("content-type", "application/json")
        .end(`{"id":"${req.getParameter(0)}"}`);
});

// the rest of the application is Express, as before
app.use(express.json());
app.post("/users", (req, res) => res.status(201).json(req.body));

app.listen(3000);
```

It is for the few routes where every microsecond is worth more than the Express API: a health check behind a load balancer, a hot endpoint that answers from memory, a protocol of your own. Everything else stays an Express route.

## What it is, and what it is not

- **The handler is µWS's.** `res` and `req` are the objects µWS hands over, with their whole API: `writeStatus`, `writeHeader`, `end`, `tryEnd`, `cork`, `onAborted`, `onData`, `getHeader`, `getParameter`, `getQuery`, `getUrl`, `getMethod`, and the rest. The [µWS documentation](https://github.com/uNetworking/uWebSockets.js) is the reference.
- **No Express at all.** There is no `Request` and no `Response`, so no `req.body`, `req.params`, `req.query`, `res.send` or `res.json`. No `app.use()` middleware runs, neither does `app.param()`, an error handler or the application's 404. Settings such as `trust proxy`, `etag`, `x-powered-by` or `json spaces` have no effect on it.
- **µWS's rules are yours.** `req` can only be read before the handler returns, so read what you need first. An answer written after the handler returns needs `res.onAborted()` registered before returning, and `res.cork()` around the writes, exactly as on a bare µWS app:

    ```js
    app.uws("get", "/slow", (res, req) => {
        const id = req.getQuery("id"); // read now, req is gone after this function returns
        let aborted = false;
        res.onAborted(() => {
            aborted = true;
        });
        lookup(id).then((value) => {
            if (aborted) return;
            res.cork(() => res.writeStatus("200 OK").end(value));
        });
    });
    ```

- **The method** is one of `get`, `post`, `put`, `delete` (or µWS's `del`), `patch`, `options`, `head`, `connect`, `trace`, or `any` (or `all`), in either case. A `get` route does not answer `HEAD`, as on µWS: the `HEAD` goes on to the Express routes.
- **The path is a µWS pattern**: literal, `:name` for a whole segment (read back with `req.getParameter(0)` or `req.getParameter("name")`), `*` for the rest of the path. It is matched byte for byte, so case-insensitive routing does not apply: `/Health` is not `/health`, and goes on to the Express routes.

## Which route answers

A raw route answers before the Express application on every path its pattern takes, whether it was written before or after the Express routes. It cannot take a place among them, since it skips the router that keeps them in order.

```js
app.get("/users/me", (req, res) => res.send("from Express"));
app.uws("get", "/users/:id", (res, req) => res.end("raw " + req.getParameter(0)));

// GET  /users/me     -> "raw me"        the raw pattern takes it
// GET  /users/42     -> "raw 42"
// POST /users/42     -> Express         another method
// GET  /users/42/x   -> Express         another path
// GET  /USERS/me     -> "from Express"  another case, which µWS does not match
```

To keep that true whatever the patterns are, an Express route that a raw route could take is not handed to µWS's router at `listen()` and is served the ordinary way instead: µWS prefers the more specific pattern, and `/users/me` would otherwise beat `/users/:id`. Every other Express route keeps its native registration. `npx fulmine.js profile` names the raw route that took each one, and `express.testing.routeReport(app)` gives the same reason to a test.

## Routers and `listen()`

- **Routers work.** `router.uws("get", "/ping", handler)` mounted with `app.use("/api", router)` serves `/api/ping`. The mount path has to be one µWS can match, a literal or one whose parameters are whole segments; a raw route under any other mount throws at `listen()`, since nothing could fall back to it. The pattern µWS matches is the whole path, so the parameters of a mount such as `/t/:tenant` come first by index: read them by name, `req.getParameter("id")`, and the mount does not shift them.
- **After `listen()`**, a raw route added on the application goes straight to µWS, as µWS itself allows. The Express routes already handed to µWS are not reconsidered, so on a path both could take µWS's own precedence decides.
- **Node only, through `app.listen()`.** On Bun and Deno, where µWS does not load, `listen()` throws for an application with a raw route. Under `http.createServer(app)` and supertest there is no µWS to hand it to, and requests go to the Express routes: test a raw route against a real `app.listen()`.
- **`app.close()`** stops the listening socket as usual, but it does not wait for a raw route's pending answers: it knows nothing about them.

`app.uwsApp` is still there for anything µWS offers that this does not; `app.uws()` is the same registration with the ordering above taken care of. Runnable: [`examples/uws-route.js`](../examples/uws-route.js).
