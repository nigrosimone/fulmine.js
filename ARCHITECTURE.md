# Architecture

How a request goes through this library, and who owns what. For the rules about working here read
[`CLAUDE.md`](./CLAUDE.md) and [`CONTRIBUTING.md`](./CONTRIBUTING.md) instead.

## The one idea

There are two ways to serve a request, and both have to give the same answer.

- **The native path.** At `listen()` the routes that can be matched by path alone are registered
  with uWS itself. uWS matches the URL in C++ and calls a handler that already knows which
  middlewares run, in which order. No layer is matched again in JavaScript.
- **The generic path.** Everything else. One uWS catch-all handler receives the request and the
  router walks its own table, layer by layer, the way Express does.

Every decision the optimizer takes is a claim that the native path answers what the generic path
would have answered. `npm run fuzz -- --self` serves one application both ways and compares. When
the claim cannot be made, the route stays generic: that is always correct, only slower.

A third step sits on top of the native path: a handler simple enough to be read at startup is
compiled into a uWS declarative response and never enters JavaScript at all.

## The files

Entry and wiring

| file              | what it is                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `index.js`        | the factory and the namespace: `express()`, `express.Router`, `express.json`, ...           |
| `application.js`  | `Application`, which is a `Router` plus settings, `listen()`, `close()` and the view engine |
| `router.js`       | `Router`: the route table, registration, dispatch entry, `app.param()`                      |
| `route.js`        | Express's `Route`, the handlers of one path and the walk over them                          |
| `server-shape.js` | what makes an application answer as an `http.Server`, `instanceof` included                 |
| `cluster.js`      | `{ cluster: "auto" }`: one process per core, all binding the same port                      |
| `hot-settings.js` | the settings the hot paths read, resolved to plain fields                                   |
| `nest.js`         | `fulmine.js/nest`, the NestJS HTTP adapter                                                  |

Routing

| file              | what it is                                                                      |
| ----------------- | ------------------------------------------------------------------------------- |
| `optimizer.js`    | decides which routes uWS can serve, builds their chains, registers them         |
| `router-utils.js` | the pieces dispatch needs: guards, mount prefixes, param names, the error page  |
| `walk.js`         | `Walk`, one walk of one router's table for one request. This is `next()`        |
| `parse-query.js`  | the default query parser, node's `querystring` semantics on a null prototype    |
| `declarative.js`  | reads a handler at startup and, when it can, compiles it into a response        |
| `usage.js`        | reads a handler's source to prove it never touches headers or query             |
| `utils.js`        | patterns to regex, path overlap, ETags, encoding negotiation, header validation |

Request and response

| file                | what it is                                                                             |
| ------------------- | -------------------------------------------------------------------------------------- |
| `request.js`        | `Request`, built for every request. Almost everything on it is lazy                    |
| `request-utils.js`  | address formatting, framing checks, the request-smuggling refusals                     |
| `response.js`       | `Response`, `send`, `sendFile`, `json`, the header methods, the uWS writes             |
| `response-utils.js` | header buffers, status lines, the node symbols the response has to carry               |
| `lazy-readable.js`  | a `Readable` whose state is built on the first touch                                   |
| `lazy-writable.js`  | the same for `Writable`                                                                |
| `socket.js`         | enough of a node socket for middleware that reaches for one                            |
| `node-shim.js`      | uWS-shaped request and response over node's own, for supertest and `createServer(app)` |

Middleware and extras

| file               | what it is                                                       |
| ------------------ | ---------------------------------------------------------------- |
| `middlewares.js`   | `express.static` and the four body parsers                       |
| `compression.js`   | `express.compression()`                                          |
| `server-timing.js` | `express.serverTiming()`, with the routing verdict in the header |
| `testing.js`       | `express.testing`, so a test can assert a route stayed native    |
| `work.js`          | what one request actually made the framework do                  |
| `view.js`          | template lookup and render                                       |
| `websocket.js`     | `app.ws()` and the upgrade handshake                             |
| `worker.js`        | the file-reading worker thread `express.static` uses             |

Tools

| file        | what it is                                                    |
| ----------- | ------------------------------------------------------------- |
| `cli.js`    | `npx fulmine migrate / profile / verify / override / angular` |
| `verify.js` | whether this machine and image can load the binary at all     |
| `adopt.js`  | the two commands that edit a JSON file instead of source      |

## Startup

`app.listen()` does four things before it binds:

1. `_compileOptimizedRoutes()` walks the table. For each route it asks whether uWS can match its
   path, whether anything registered earlier could answer the same path, and what runs in front of
   it. What passes gets a chain: the exact list of layers, worked out once.
2. `registerUwsRoute()` registers each chain with uWS. A literal path also gets a _preset_, the
   constants uWS matched byte for byte, so the request constructor does not ask for them again.
3. `usage.js` reads every callback in the chain. When none of them can touch a header or the query,
   the registration is granted a _skip_ and the constructor leaves that work undone.
4. `declarative.js` tries to compile the last handler into a uWS response. If it can, the route
   never reaches JavaScript again.

Then the catch-all `any("/*")` is registered, and it serves everything else.

Nothing is compiled twice: registering a route after `listen()` takes the granted skips back,
because that is code the analysis never saw.

## A request on the native path

1. uWS matches the path and calls the registered handler.
2. `handleRequest()` builds a `Request` and a `Response` and links them. The constructor copies the
   headers out of uWS, unless the chain was granted the skip, in which case it reads by name only
   what steers framing.
3. A `Walk` runs the chain. There is no matching: the chain is what runs.
4. If the chain falls through, ordinary routing takes over from the top, skipping what already ran.

## A request on the generic path

1. uWS calls the catch-all, `_serveGeneric`.
2. `handleRequest()` builds the pair, with no preset and no skip.
3. `Walk#dispatch` scans the router's table from the current index. `_scanFrom` uses an index over
   the literal routes, so the scan visits the few that could match plus every non-literal one.
4. A layer that matches is entered: `app.param()` callbacks run, then its callbacks, one after
   another, through `next()`.
5. A mount hands the walk to the mounted router, which gets a `Walk` of its own.
6. Running out of table answers 404, or the automatic OPTIONS reply.

## What the walk carries on the request

These fields are the dispatch protocol. They are private and they are the thing to understand
before changing `walk.js` or `router.js`.

| field                       | meaning                                                                     |
| --------------------------- | --------------------------------------------------------------------------- |
| `_originalPath`             | the path as it arrived, before any mount consumed anything                  |
| `_path` / `_opPath`         | the path being matched now, and its comparison form                         |
| `_lastUrl` / `_lastMethod`  | what the walk last saw, so an assignment by a middleware is noticed         |
| `_stack` / `_consumed`      | the mounts entered, and how many characters of path they took               |
| `_error`                    | the error in flight, if any                                                 |
| `_errorKey` / `_errorGroup` | where it was raised, so only handlers after that point catch it             |
| `_leaveRoute`               | the `next` that leaves the whole route, which is what `sendFile` reports to |
| `_mustRefuse`               | the framing is not trustworthy, hang up without answering                   |
| `_matchedMethods`           | the verbs a path answers, for the OPTIONS reply                             |

Two rules follow from Express and are easy to break:

- A mounted router or application is **stepped over** while an error is in flight. What a mount
  catches is what it raised itself.
- A route layer is skipped entirely while an error is in flight, so a four argument handler written
  inside a route only sees what that route raised.

## Where the two paths must agree

These are the places a change breaks compatibility quietly, because the answer stays correct:

- **Registration order.** Express picks by order, uWS picks by specificity. `guardsInside` and
  `shadowsLeaf` are what keeps a route off the native path when an earlier layer could answer it.
- **Case and strict routing.** uWS matches bytes. A request in another case takes the fallback.
- **Headers seeded per response.** A compiled response writes the same `connection` and `keep-alive`
  the generic path writes, or the same route would answer different headers depending only on
  whether it happened to be compilable.
- **ETags.** A compiled response cannot honour a conditional request, so a route that would carry a
  validator is not compiled.

## The node shim

`http.createServer(app)` and supertest hand the application a node request. `node-shim.js` wraps it
in the eighteen calls `Request` and `Response` make into uWS. Nothing on that path is fast and it
does not need to be: it exists so the test suites and anything holding a real server keep working.
