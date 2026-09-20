---
description: Explore Fulmine.js benchmarks against Express, how native routing reduces overhead, where gains are limited, and how to inspect and tune your routes.
---

# Performance

Fulmine is faster than Express where the framework itself is doing the work, and the same speed where it is not. Both halves of that sentence matter, so here is the honest version.

**Where it is clearly faster.** Routing and dispatch, request shapes with params and query strings, connection handling. The spreads below are the CI runs of August and September 2026, which landed on six different runner shapes, all on Node 26. Plain routing lands between 1.2x and 4.5x: hello-world 1.2x to 2.3x, an API endpoint with params and a query 1.8x to 4.5x, five route shapes served by one process 1.5x to 3.6x, nested routers 1.5x to 3.1x, a urlencoded body 2.1x to 5.3x, a thousand concurrent connections 2.2x to 3.3x. Route tables are where the native router shows: a thousand routes 7.4x to 18.3x, with a parameter in every one of them 7.7x to 22.4x, a parameterised route in a mounted router 4.3x to 9.7x. Those routes go to µWS's own router instead of being scanned, so the gap grows with the table instead of shrinking. Even the chain of 100 middlewares, for a long time the one routing row that stayed even because its cost is calling application code a hundred times, sits at 1.3x to 2.8x after the per-request work of August 2026. Those spreads are wider than they were: the newest runners are much faster for Express, which moves the ratio without either server changing, and the low end of every row now comes from one of them.

**Where it is a wash.** Any request whose cost is dominated by work both servers hand to the same library. A 512 KiB JSON body is `JSON.parse`, a gzipped response is zlib, a hashed upload is OpenSSL, a 5 MiB stream is memory bandwidth. On those the ratio is capped by arithmetic somewhere between 1.0x and 1.5x, depending on how much of the request is the shared work, and no amount of effort on either server moves it. The benchmark labels those rows rather than quietly publishing them as if the two were equivalent.

Two things worth knowing before comparing numbers with anyone:

- **Node 24 moved the baseline.** Express got roughly 3x faster on the routing benchmarks between Node 22 and Node 24, while a µWS-based server barely moved, because the gain came from `node:http`. Any comparison published before mid-2026 overstates the current gap.
- **Ratios are not portable across runs.** GitHub's runners vary enough that the same code measures 15k or 28k req/sec on the same row. Only compare figures produced in the same run.

There is no table here on purpose. CI runs the whole benchmark on every push and every pull request
and posts the result where it belongs: as a comment on the commit or the pull request, and as a
`benchmark-summary` artifact on the run, see [`benchmark/README.md`](../benchmark/README.md)
to run it yourself.

## Public benchmarks

Numbers produced by a project about itself deserve suspicion, so Fulmine also stands in public arenas, run by their own rigs under their own rules:

- **[HttpArena](https://www.http-arena.com/#sort=rps:-1&q=Js)**: thirty profiles on 64-core dedicated hardware, same conditions for every entry, rerun whenever one of them changes. The link lands filtered on the JavaScript entries. No figures are copied here on purpose: the board is the current one and this page would not be.
- **[web-frameworks](https://web-frameworks-benchmark.netlify.app/result?l=javascript)**: in the published round, ranked with the other sixty-odd JavaScript entries on their own hardware. Same rule as above, no figures copied here.

More to come as their maintainers take the entries in.

## Performance tips

Where the speed comes from, before the rules that govern it. Express finds a route by walking its
stack and testing each layer against the path. Fulmine hands every route it can to µWS's own router,
which matches in C++, and works out at `listen()` which layers stand in front of each one, so
arriving at a handler costs no matching at all:

```text
   Express                              Fulmine
   GET /users/42                        GET /users/42
        |                                    |
        v                                    v
   +--------------+                    +------------------+
   | layer 1      | path? no           |   µWS router     |  one match, in C++,
   | layer 2      | path? no           |   /users/:id     |  against every path
   | ...          |                    +--------+---------+  registered
   | layer 214    | path? yes -+                |
   +--------------+            |                v
     a test per layer,         |       +------------------+
     every request             |       | the chain, known |  the layers in front,
                               |       | since listen()   |  in order, no matching
                               v       +--------+---------+
                            handler             |
                                                v
                                             handler
```

That is the whole difference on a large route table: the scan grows with the table and the match
does not, which is why a thousand routes measure 10x and a handful measure 3x.

Two more things happen on the way in, and `npx fulmine.js profile` will tell you which of them your
routes get:

```text
   a request arriving at a compiled route

   µWS match ──► the chain ──────────────────────────► handler ──► response
                    |                                     |
                    |  a body parser is stepped over      |  the Readable is not
                    |  when the request declared no       |  built unless something
                    |  body and the verb reads none       |  asks the body for one
                    |                                     |
                    |  the headers are not copied out     |  the two internal
                    |  of µWS when the analysis proved    |  listeners are written
                    |  nothing in the chain reads one     |  into the event map
                    v                                     v
              work that does not happen           work that is not prepared

   and when the handler is simple enough to be read at registration time, none of the
   above happens either: µWS answers from a response written once, at startup
```

1. Fulmine tries to optimize routing as much as possible, but it's only possible if:

- the path is a plain string, or its parameters are whole segments: `/users/:id` and `/a/:b/c/:d` qualify, `/flights/:from-:to` does not, and neither does a `*splat` or a `{}` group. Routing is case-insensitive by default, as in Express; a request in the registered case is still served natively, any other case takes the ordinary path, and a route whose overlap with an earlier one leans on a cased literal goes the ordinary way for every request. That last one is worth knowing about: `app.set("case sensitive routing", true)` is Express's own setting, and with it `/Users/list` no longer overlaps `/users/:id`, so both are matched by µWS instead of one of them falling back.
- inside a mounted router, nothing registered after the route in that router could match the same path. `/orders/:id`, `/orders/:id/items` and `/invoices/:id` are all optimized together, since no request reaches two of them. `/users/:id` followed by `/users/me` is not: Express answers `/users/me` with the first of the two and the native router would answer it with the second, so both go the ordinary way.

Optimized routes can be up to 10 times faster than normal routes, as they're using native uWS router and have pre-calculated path.

On top of that, a handler simple enough to be read at registration time is compiled into a uWS declarative response and answered natively, without entering JavaScript at all. That needs the route to have nothing in front of it, not a middleware and not a `Router` it was mounted under, and a single handler that only calls `res.status`, `res.set`, `res.type`, `res.append`, `res.send`, `res.json`, `res.sendStatus` or `res.end` with literal arguments. `res.set` takes a pair or a whole object of them, and `res.type` takes what it takes anywhere, since a media type is a lookup on a literal. Anything else, a variable, a call, an `if`, falls back to ordinary routing. `return res.send(...)` compiles, `res.send(...)` does too, and so does an object or an array of literals however deeply nested. Mounting a `Router` costs only this: the routes inside one are still registered on the native uWS router with their full path, and are as fast as any other optimized route.

Three things are refused whatever the handler does, and all three are the same fact: a response written at startup cannot read the request.

- one that would carry an `ETag` or a `Last-Modified`, since it could never answer with the `304 Not Modified` that the validator invites. `etag` is on by default, so `app.set("etag", false)` is what puts an ordinary route on this path.
- one whose route captures, `/users/:id`, or whose body copies a piece of the request, `res.send(req.query.q)`, unless `app.set("declarative request values", true)`. uWS reads the request its own way, not as Express does: a parameter that cannot be decoded is a `400` in Express and nothing runs here to raise it, a parameter that can goes out undecoded, a query key that is repeated gives the first value where Express gives an array, and one that is missing gives nothing where Express writes `undefined` into a longer body. Turn it on where the values are plain, an id in a path, and the handler does nothing but write them back.
- a `204`, `205` or `304`, since the body would go out with the status and a client frames those as bodiless whatever it reads.

Two things then follow from the response being static:

- it carries a `Content-Length` while its body is literal all the way through. A body with a piece taken from the request, under `declarative request values`, has no length until the request arrives, so that one is framed as `Transfer-Encoding: chunked`. uWS writes the framing either way, which is why neither header can be set by hand.
- it answers `Connection: keep-alive` even to a request that asked for `Connection: close`. The connection is still closed, since uWS decides that itself, and a client that asked to close is closing anyway.

`app.set("declarative responses", false)` turns the whole thing off if you would rather have Express's exact framing than the speed.

None of that is guesswork you have to do from the outside. `listen()` decides it all, and `npx fulmine.js profile` prints what it decided:

```sh
npx fulmine.js profile              # the file "main" or the start script points at
npx fulmine.js profile server.js    # or name it
```

```text
7 route(s), 4 answered by µWS itself

  GET    /api/health          µWS  /api/health  (2 in front of it in its chain)
  GET    /hello               µWS  /hello  (compiled to a response, reads no query)
  GET    /:anything           router: something before it in the same router overlaps its paths
  GET    /after-the-param     router: the parameter route /:anything is written before it
  SEARCH /odd                 router: µWS does not serve SEARCH

What this adds up to

  4 of 7 route(s) matched by µWS in C++
  1 answered from a response written at startup, running no javascript
  layers in front of a compiled handler: 1 at least, 2 at most, 1.8 on average

Worth changing, if these are routes that carry traffic

  GET /after-the-param
    write it above /:anything. Express answers whichever matches first, so the order is
    already what decides, and with the literal first µWS can match it in C++ as well.
```

It loads the application with `listen()` replaced by the half that compiles the routes, so nothing binds a port and the listen callback does not run: profiling a running service does not start a second copy of it. There is no score, on purpose. A percentage of routes is not a percentage of traffic, and an application with a thousand cold routes and one hot one that fell back would score well and serve badly.

The same verdicts are readable from a test, which is where they belong for the routes that carry the traffic. A route stays on the fast path only while it stays eligible, and nothing complains when it stops: the answer is still correct, only slower, and the commit that did it is found weeks later.

```js
const { expectNative, expectDeclarative, routeReport } = require("fulmine.js").testing;

expectNative(app, ["/api/*", "GET /health"]); // throws, naming the route and the reason
expectDeclarative(app, "/health"); // the step past native: no javascript at all
routeReport(app); // the whole list, to assert on however you like
```

A path is written as it was registered, `"/users/:id"` and not `"/users/7"`, and a trailing `*` names everything under a prefix. A pattern that matches no route throws too, so a misspelled path fails instead of passing quietly. The application does not need to be listening. Runnable: [`examples/fast-routes.js`](../examples/fast-routes.js).

A route can stay native and still slow down request by request, because most of what makes this fast is work that does not happen: the request is not turned into a `Readable`, the response is not turned into a `Writable`, `req.headers` is not folded into an object, the query is not parsed, no socket stand-in is allocated. A middleware that reads `req.headers.host` puts one of those back on every request, and nothing fails. `expectLazy` is the assertion for that half, asked from inside a handler:

```js
const { workReport, expectLazy } = require("fulmine.js").testing;

app.post("/items", (req, res) => {
    expectLazy(req, res, { allow: ["body"] }); // throws naming what else was built
    workReport(req, res); // { native, declarative, headers, query, body, requestStream, ... }
    res.json(req.body);
});
```

Asking costs a property read: every field is state the framework already keeps, nothing is counted or wrapped to make it readable.

`npx fulmine.js explain /api/items/:id` answers the other question, the one about a single endpoint rather than about the table: how it is matched, what is copied out of the request, what runs and what each layer costs the route.

```text
GET /api/items/:id

  route      native (µWS matched /api/items/:x and dispatched by method)
  headers    copied out of µWS (something in the chain reads them)
  query      parsed when something asks for it
  chain      2 layer(s), 1 mounted layer(s) in front of it
    logger                readable at registration, reads the query
    (anonymous)           readable at registration
  body       read for POST, PUT, PATCH and QUERY, when one is declared
```

The same verdict reaches the browser, per request, with `express.serverTiming()`:

```text
Server-Timing: route;desc="native", hdr;desc="not copied", db;dur=3.62, total;dur=4.66
```

`route;desc="native"` means µWS matched the path in C++ and the chain was worked out at startup; `route;desc="router"` means this one was matched here, layer by layer. `res.timing(name, ms, desc)` and `res.time(name, fn)` add marks of your own, and `fn` may return a promise. The duration ends where the header does, since Server-Timing goes out with the head. A route compiled into a response never enters JavaScript, so nothing times it: `npx fulmine.js profile` is where those are counted. The same middleware writes `work;desc="headers, query"` when the request built something a fast one does not, the fields `expectLazy` checks, and writes nothing when it built none of them. `serverTiming({ work: false })` turns that off. Runnable: [`examples/server-timing.js`](../examples/server-timing.js).

2. Do not use external `serve-static` module. Instead use built-in `express.static()` middleware, which is optimized for Fulmine. If your build already writes `.br` and `.gz` files next to the originals, `express.static(dir, { preCompressed: true })` serves those to the clients that accept them, so nothing is compressed at request time and a fraction of the bytes goes out: on a 4KB script with a brotli twin, 12 times fewer. It costs no more than serving the file itself, one `stat` per request, because the twin is looked for before the file and its own `stat` is the only one the request needs. A type that is already compressed, a woff2 or a webp, is not looked up at all, and which twins a path has is remembered for a second: `{ cache: false }` asks the disk every time, `{ cache: "5s" }` sets the window. Only their presence is remembered, never their size or mtime, so nothing is ever described by a stale number. `Vary: Accept-Encoding` is sent whether or not a twin is found, the content type stays the one the requested name implies, and each variant carries its own ETag. Runnable: [`examples/static-precompressed.js`](../examples/static-precompressed.js).

3. Do not use `body-parser` module. Instead use built-in `express.text()`, `express.json()` etc.

4. Do not use the `compression` module. `express.compression()` takes the same options and decides the same way, and it served about 50% more requests per second on an 8KB JSON body here, gzip and brotli alike. A response that arrives whole, which is every `res.send()` and `res.json()`, is compressed in one call rather than through a transform stream and goes out with a `Content-Length` instead of chunked; a response written in pieces still streams. The bytes are the same bytes either way.

```js
// the compression module's options, unchanged: threshold, filter, level, brotli, enforceEncoding
app.use(express.compression({ threshold: 1024 }));
```

One option is Fulmine's own, `encodings`: the list of what the middleware may answer with, out of `"br"`, `"gzip"` and `"deflate"`. What is not named is never used, however the client ranks it, and an uncompressed answer is always on offer. It exists because the preferred encoding is a cost decision, not only a size one: brotli compresses smaller but what it costs per response depends on the machine, and on a CPU where it runs expensive `encodings: ["gzip"]` buys the cheaper call for every client that accepts both.

```js
// answer gzip even to a client that also accepts br
app.use(express.compression({ level: 1, encodings: ["gzip"] }));
```

Runnable: [`examples/compression.js`](../examples/compression.js).

5. If a route answers with a JSON shape you know in advance, [express-fast-json-stringify](https://www.npmjs.com/package/express-fast-json-stringify) compiles that shape into a serializer and `res.fastJson()` replaces `res.json()`. `JSON.stringify()` has to walk an object it knows nothing about; a compiled serializer does not. It is worth reaching for, and a CPU profile says why: on a route answering 3.6KB of JSON, serialising it is about 25% of the time that is not spent waiting, ahead of the ETag at 19% and of everything the framework does to route the request and build its request and response objects.

6. Do not set `body methods` to read body of requests with GET method or other methods that don't need a body. Reading body makes endpoint about 15% slower.

7. `app.set("etag", false)` is worth about 8% on small responses, measured on both Fulmine and Express, which pay it almost identically. It is the single biggest thing an ordinary route does: in a CPU profile of one, hashing the body and building the tag are about 21% of the time that is not spent waiting, more than writing the headers and more than building the request and the response together. Know what you are trading: without an ETag a client cannot make a conditional request, so there are no `304 Not Modified` replies and every response is downloaded in full. On anything cacheable the bandwidth a 304 saves is usually worth far more than the 8%. It is left on by default for that reason. Turn it off for an API whose responses are never revalidated, and note that it is the same setting that decides whether a simple route is compiled into a native response, above.

8. By default, Fulmine creates 1 (or 0 if your CPU has only 1 core) child thread to improve performance of reading files. You can change this number by setting `threads` to a different number in `express()`, or set to 0 to disable thread pool (`express({ threads: 0 })`). Threads are shared between all express() instances, with largest `threads` number being used. Using more threads will not necessarily improve performance. Sometimes not using threads at all is faster, so measure both.

9. One node process uses one core, and this is the setting that changes it. `express({ cluster: "auto" })` forks one process per core and each of them binds the same port with µWS's shared flag, which is `SO_REUSEPORT`: every process has its own listening socket and the kernel decides which one gets each connection. Node's own `cluster` cannot do that with an `http.Server`, so the primary holds the socket and passes each accepted connection to a worker over IPC; here the primary is not in the path at all. On a 16-core machine that is close to 16 times the throughput, and no other setting comes near it.

```js
// "auto" is one worker per usable core: the cgroup quota is read first, so a 2-core container
// on a 64-core host forks 2 and not 64. A number instead of "auto" says how many.
const app = express({ cluster: "auto" });

app.get("/", (req, res) => res.send("hello"));

// The whole file runs again in every worker, which is how cluster works: the code above this
// line runs once per process. The primary only forks, so the callback runs once per worker too,
// and a worker that dies is replaced.
app.listen(3000, () => console.log(`worker ${process.pid} listening`));
```

Anything held per process is now held per worker: an in-memory cache, a rate-limit counter, a session store or a `Map` of connected sockets is not shared, and needs Redis or something like it to be. `app.close()` in the primary stops the workers, and a `SIGTERM` or `SIGINT` that reaches only the primary, which is what a container sends, is passed on to them. Runnable: [`examples/cluster.js`](../examples/cluster.js).

10. `app.set("connection headers", false)` stops `Connection: keep-alive` and `Keep-Alive: timeout=10` going out on every response. Express sends both, so Fulmine sends both by default. An HTTP/1.1 connection stays open without being told, so to an HTTP/1.1 client the two headers say nothing it does not know already, and they cost 46 bytes and two header writes per response. A request that asked for `Connection: close` still gets `Connection: close`, and the connection is closed. Turn it off for an API behind a proxy or serving HTTP/1.1 clients; keep the default where a client or a proxy relies on the header to keep the connection open. Worth 2% to 3.5% here on a route that is not compiled, plus the bytes.
