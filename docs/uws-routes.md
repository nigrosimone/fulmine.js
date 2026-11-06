---
description: "Register a raw uWebSockets.js route in a Fulmine.js app with app.uws(): the handler gets µWS's own HttpResponse and HttpRequest, with no Express layer in front."
---

# Raw µWS routes

`app.uws.get()` and the other verbs register a route that µWS serves by itself, with the handler exactly as you wrote it. It is called as `(res, req)` with µWS's own `HttpResponse` and `HttpRequest`, the way a bare µWebSockets.js application would call it: nothing of Express runs in front of it, and nothing is built for it.

```js
const express = require("fulmine.js");
const app = express();

app.uws.get("/health", (res) => {
    res.end("ok");
});

app.uws.get("/users/:id", (res, req) => {
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

- **The verbs** are `get`, `post`, `put`, `delete` (or `del`), `patch`, `options`, `head`, `connect`, `trace` and `any` (or `all`). `app.uwsLite` has the same ones. The method can be a string too, `app.uws("get", path, handler)`, for when it is in a variable.
- **The handler is µWS's**, a function, or a `DeclarativeResponse` (see below). `res` and `req` are the objects µWS hands over, with their whole API: `writeStatus`, `writeHeader`, `end`, `tryEnd`, `cork`, `onAborted`, `onData`, `getHeader`, `getParameter`, `getQuery`, `getUrl`, `getMethod`, and the rest. The [µWS documentation](https://github.com/uNetworking/uWebSockets.js) is the reference.
- **No Express at all.** There is no `Request` and no `Response`, so no `req.body`, `req.params`, `req.query`, `res.send` or `res.json`. No `app.use()` middleware runs, neither does `app.param()`, an error handler or the application's 404. Settings such as `trust proxy`, `etag`, `x-powered-by` or `json spaces` have no effect on it.
- **µWS's rules are yours.** `req` can only be read before the handler returns, so read what you need first. An answer written after the handler returns needs `res.onAborted()` registered before returning, and `res.cork()` around the writes, exactly as on a bare µWS app:

    ```js
    app.uws.get("/slow", (res, req) => {
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

## µWS's own utilities: `express.uWS`

`express.uWS` is µWebSockets.js itself, the same instance the application serves with, so a raw route can use everything the module offers without requiring the binary a second time (under pnpm it is not even reachable from your project). It is loaded on the first read, not when `fulmine.js` is required, and reading it on Bun or Deno throws. It is not a named ESM export: `import express from "fulmine.js"`, then `express.uWS`.

`getParts()` splits a `multipart/form-data` body. Collecting the body is the handler's, as on µWS:

```js
const { getParts } = express.uWS;

app.uws.post("/upload", (res, req) => {
    const contentType = req.getHeader("content-type"); // before returning
    let aborted = false;
    res.onAborted(() => {
        aborted = true;
    });
    const chunks = [];
    res.onData((chunk, isLast) => {
        // µWS reuses the chunk's memory once this returns, so it is copied
        chunks.push(Buffer.from(new Uint8Array(chunk)));
        if (!isLast || aborted) return;
        const parts = getParts(Buffer.concat(chunks), contentType) ?? [];
        // each part: { name, data: ArrayBuffer, filename?, type? }
        res.cork(() => res.end(parts.map((p) => p.name).join(",")));
    });
});
```

`DeclarativeResponse` writes a response once, at startup, and µWS answers with it without entering JavaScript at all. What its `end()` returns is a route of its own, as µWS takes it:

```js
app.uws(
    "get",
    "/hello/:name",
    new express.uWS.DeclarativeResponse()
        .writeHeader("content-type", "text/plain")
        .write("hello ")
        .writeParameterValue("name")
        .end("")
);
```

The compression constants of `app.ws()` behaviors (`express.uWS.SHARED_COMPRESSOR` and the rest) are there too.

## Utilities: `express.uwsUtils`

A raw route stays raw: `res` and `req` are µWS's own, and nothing is built for it. `express.uwsUtils` is a set of plain functions over them, so the parts every route writes the same way are one call, and a route pays only for what it calls.

```js
const { query, readJson, send } = express.uwsUtils;

app.uws.post("/users/:id", (res, req) => {
    const id = req.getParameter(0); // read now, as every read of req
    const { notify } = query(req);
    readJson(res, (user) => {
        send(res, 201, { "x-notify": String(notify === "1") }, { id, ...user });
    });
});
```

- **`query(req)`** is the query string as `req.query` has it. It reads `req`, so call it before the handler returns.
- **`readText(res, callback, options)`**, **`readJson`**, **`readForm`** and **`readBuffer`** give the whole body, sent with a content-length or chunked, parsed as the name says. `options.limit` takes bytes or a string as `"1mb"`, the default is 100kb. Over the limit the client gets a 413 and the callback is not called, and invalid JSON gets a 400 in the same way. An empty body is `undefined` for `readJson`.
- **`readBuffer`** lends the bytes, as `req` lends what it holds: a body that came in one piece is µWS's memory, good until the callback returns. Copy it with `Buffer.from(body)` to keep it.
- **`send(res, status, headers, body)`** is the response in one call. The body is a string, bytes, a `Readable` (a file with `fs.createReadStream()`), or anything else as JSON, and it gets the content-type it implies unless `headers` has a `content-type`. Header names are lowercase, and `headers` can be `null`. It does `cork()` for you, and a stream goes out with µWS's backpressure: it stops when the client stops reading.
- **`guard(res)`** registers the `onAborted` µWS wants before an answer written later. After an abort `send()` does nothing. The read functions and `send()` with a stream call it themselves, so a route needs it by hand only when it waits for something else, and it has to run before the handler returns:

```js
app.uws.get("/slow", (res) => {
    guard(res);
    setTimeout(() => send(res, 200, null, "late"), 200);
});
```

### Compression

`compressor(options)` is `express.compression()` for a raw route: the same options, without `filter`, and the same encoders, so the same bytes. Build it once, outside the route. `negotiate(req)` reads `Accept-Encoding`, before the handler returns, and `send()` takes its answer as the last argument:

```js
const compress = express.uwsUtils.compressor({ encodings: ["br", "gzip"] });

app.uws.get("/report", (res, req) => {
    compress.send(res, 200, null, buildReport(), compress.negotiate(req));
});
```

As with the middleware, a body under `threshold` or with a type that does not compress goes out as it is, a compressible type carries `Vary: Accept-Encoding`, and a large body is compressed on the thread pool.

## Lite routes: `app.uwsLite`

`app.uws` hands you µWS's own objects. `app.uwsLite` is the same route served by µWS, with a handler `(req, res)` and the part of Express most routes use, over two small objects:

```js
app.uwsLite.get("/users/:id", (req, res) => {
    res.json({ id: req.params.id, full: req.query.full === "1" });
});

app.uwsLite.post("/users/:id", { body: "json", limit: "1mb" }, (req, res) => {
    res.status(201).json({ id: req.params.id, ...req.body });
});
```

The body is ready when the handler runs. The same handler works on an ordinary Express route, and `app.uwsLite()` registers one for you, so what µWS does not answer still reaches it: HTTP/2, `http.createServer(app)`, a `HEAD`, a trailing slash, another case.

- **`req`** has `query`, `params` (decoded), `body`, `method`, `path`, `url`, `get(name)` and `header(name)`. On a route with middleware it has `headers` too.
- **`res`** has `req`, `statusCode`, `headersSent`, `status()`, `set()`, `header()`, `get()`, `type()`, `send()`, `json()`, `end()`, `sendStatus()`, `write()`, `setHeader()`, `getHeader()`, `hasHeader()`, `removeHeader()` and the listeners (`on()`, `once()`, `off()`), and answers as Express: the same type, charset and status. A header with an invalid name or value throws. Over µWS it writes no `ETag` and no `X-Powered-By`.
- **Options:** `body` is `"text"`, `"json"`, `"form"`, `"buffer"`, `"lent"` or `"stream"`, and `limit` is bytes or a string as `"1mb"`, 100kb by default. The route accepts any content-type. Over the limit is a 413, invalid JSON a 400, and the handler does not run. `compress` is `true`, or the options of `express.compression()`, and it is off without it.
- **`"lent"`** is a `Buffer` on µWS's memory, without a copy, good until the handler returns. For a route that answers at once, use `"buffer"` to keep it or to answer later.
- **`headers` and `url`:** `req` of µWS is gone when the handler returns, and it is gone before the handler runs on a route with a body. `query`, `params` and `body` stay. What else you read then has to be declared, and an undeclared read throws:

```js
app.uwsLite.post("/orders", { body: "json", headers: ["authorization"], url: true }, async (req, res) => {
    const user = await check(req.get("authorization"));
    res.json(await save(user, req.body, req.path));
});
```

**Middleware** goes on the route, in `use`, and a route without it pays nothing:

```js
const common = [helmet(), cors(), auth];

app.uwsLite.get("/orders/:id", { use: common }, (req, res) => {
    res.json(load(req.user, req.params.id));
});
```

- It is `(req, res, next)`, sync or async. It can answer and stop the chain, and put values on `req` for the handler.
- `(err, req, res, next)` receives what the earlier ones threw or passed to `next()`. An error nobody takes answers its `status`, or 500.
- It runs after the body is read, as `express.json()` at the top of an app. To run after the handler, use `res.on("finish", fn)`.
- All the headers are kept, so `req.headers` and `req.get()` work after an await. That is the cost of a route with `use`.
- It takes no `"lent"` body, because middleware can outlive it.
- An Express middleware works if it needs only what is here. `helmet` and `cors` are tested. One that reads `req.ip`, `req.socket` or `res.locals` does not, and `next("route")` is an error.

**Streams** work as on an Express route, so the handler is the same on both:

```js
app.uwsLite.get("/report", { compress: true }, (req, res) => {
    res.type("text/csv");
    fs.createReadStream("report.csv").pipe(res);
});

app.uwsLite.post("/upload", { body: "stream" }, async (req, res) => {
    await pipeline(req.body, fs.createWriteStream(target()));
    res.sendStatus(201);
});
```

`res.write()` and `stream.pipe(res)` answer chunked with backpressure, and compressed if the route has `compress` and the type is compressible. `body: "stream"` makes `req.body` a `Readable`, with backpressure and no `limit`, you count what you read.

What it does not have: no `app.use()` middleware runs, no `app.param()`. A handler that throws or rejects answers the `status` of the error, or 500, and logs the error. Settings such as `etag`, `json spaces` or `trust proxy` have no effect over µWS. The path is as in `app.uws()`, without `*`. For anything else use an Express route: it is the same handler.

## Which route answers

A raw route answers before the Express application on every path its pattern takes, whether it was written before or after the Express routes. It cannot take a place among them, since it skips the router that keeps them in order.

```js
app.get("/users/me", (req, res) => res.send("from Express"));
app.uws.get("/users/:id", (res, req) => res.end("raw " + req.getParameter(0)));

// GET  /users/me     -> "raw me"        the raw pattern takes it
// GET  /users/42     -> "raw 42"
// POST /users/42     -> Express         another method
// GET  /users/42/x   -> Express         another path
// GET  /USERS/me     -> "from Express"  another case, which µWS does not match
```

To keep that true whatever the patterns are, an Express route that a raw route could take is not handed to µWS's router at `listen()` and is served the ordinary way instead: µWS prefers the more specific pattern, and `/users/me` would otherwise beat `/users/:id`. Every other Express route keeps its native registration. `npx fulmine.js profile` names the raw route that took each one, and `express.testing.routeReport(app)` gives the same reason to a test.

## Routers and `listen()`

- **Routers work.** `router.uws.get("/ping", handler)` mounted with `app.use("/api", router)` serves `/api/ping`. The mount path has to be one µWS can match, a literal or one whose parameters are whole segments; a raw route under any other mount throws at `listen()`, since nothing could fall back to it. The pattern µWS matches is the whole path, so the parameters of a mount such as `/t/:tenant` come first by index: read them by name, `req.getParameter("id")`, and the mount does not shift them.
- **After `listen()`**, a raw route added on the application goes straight to µWS, as µWS itself allows. The Express routes already handed to µWS are not reconsidered, so on a path both could take µWS's own precedence decides.
- **Node only, through `app.listen()`.** On Bun and Deno, where µWS does not load, `listen()` throws for an application with a raw route. Under `http.createServer(app)` and supertest there is no µWS to hand it to, and requests go to the Express routes: test a raw route against a real `app.listen()`.
- **`app.close()`** stops the listening socket as usual, but it does not wait for a raw route's pending answers: it knows nothing about them.

`app.uwsApp` is still there for anything µWS offers that this does not; `app.uws()` is the same registration with the ordering above taken care of. Runnable: [`examples/uws-route.js`](../examples/uws-route.js).
