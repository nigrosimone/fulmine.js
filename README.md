# Fulmine

A drop-in replacement for Express 5, running on [µWebSockets.js](https://github.com/uNetworking/uWebSockets.js) instead of `node:http`. Your existing middleware keeps working.

```js
const express = require("fulmine.js"); // instead of require("express")
```

ESM and TypeScript work the same way, named imports included:

```ts
import express, { Router, json } from "fulmine.js";
import type { Request, Response } from "fulmine.js";
```

There is a command that does that replacing for you, across a whole project, and then tells you the handful of things that behave differently:

```sh
npx fulmine migrate --dry-run   # say what it would change, change nothing
npx fulmine migrate             # do it
npx fulmine differences         # just the list of what to check by hand
```

See [Migrating](#migrating) for what it handles and what it deliberately does not.

[![npm version](https://img.shields.io/npm/v/fulmine.js)](https://www.npmjs.com/package/fulmine.js)
[![Node.js >= 22.0.0](https://img.shields.io/badge/Node.js-%3E=22.0.0-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

## Why this exists

There are several fast HTTP servers for Node built on [µWebSockets.js](https://github.com/uNetworking/uWebSockets.js). What is scarce is one you can actually drop into an existing Express application without rewriting it.

Compatibility here is not a claim, it is a test suite. Every test runs against real Express first and then against Fulmine, and the outputs have to match byte for byte. That is what makes `helmet`, `cors`, `passport`, `morgan`, `multer`, `express-session` and the rest of the ecosystem work rather than "mostly work". Express 5's own test suite runs against Fulmine too, and passes whole: 1130 passing, 0 failing at the pinned Express version.

## Performance

Fulmine is faster than Express where the framework itself is doing the work, and the same speed where it is not. Both halves of that sentence matter, so here is the honest version.

**Where it is clearly faster.** Routing and dispatch, request shapes with params and query strings, connection handling. Plain routing lands between 1.9x and 4.3x: hello-world 1.9x to 2.2x, an API endpoint with params and a query 3.2x to 4.3x, five route shapes served by one process 2.5x to 3.3x, nested routers 2.1x to 3.1x, a urlencoded body 3.4x to 4.1x, a thousand concurrent connections 2.7x to 3.2x. Route tables are where the native router shows: a thousand routes 9.7x to 12.9x, with a parameter in every one of them 10.4x to 14x, a parameterised route in a mounted router 7.1x to 8.3x. Those routes go to µWS's own router instead of being scanned, so the gap grows with the table instead of shrinking. Even the chain of 100 middlewares, for a long time the one routing row that stayed even because its cost is calling application code a hundred times, sits at 1.5x to 1.7x after the per-request work of August 2026.

The same code sits on the public [HttpArena](https://www.http-arena.com/) leaderboard, run and saved by the arena's own 64-core rig: 5.89 million pipelined requests per second, 1.12 million on baseline, 1.04 million on the json profile, ahead of every JavaScript entry on the board.

**Where it is a wash.** Any request whose cost is dominated by work both servers hand to the same library. A 512 KiB JSON body is `JSON.parse`, a gzipped response is zlib, a hashed upload is OpenSSL, a 5 MiB stream is memory bandwidth. On those the ratio is capped by arithmetic somewhere around 1.0x to 1.2x, and no amount of work on either server moves it. The benchmark labels those rows rather than quietly publishing them as if the two were equivalent.

Two things worth knowing before comparing numbers with anyone:

- **Node 24 moved the baseline.** Express got roughly 3x faster on the routing benchmarks between Node 22 and Node 24, while a µWS-based server barely moved, because the gain came from `node:http`. Any comparison published before mid-2026 overstates the current gap.
- **Ratios are not portable across runs.** GitHub's runners vary enough that the same code measures 15k or 28k req/sec on the same row. Only compare figures produced in the same run.

There is no table here on purpose. CI runs the whole benchmark on every push and every pull request
and posts the result where it belongs: as a comment on the commit or the pull request, and as a
`benchmark-summary` artifact on the run, see [`benchmark/README.md`](./benchmark/README.md)
to run it yourself.

## Attribution

Fulmine is a derivative work of [Ultimate Express](https://github.com/dimdenGD/ultimate-express) by [@dimdenGD](https://github.com/dimdenGD), used under the Apache License 2.0. The full commit history is preserved, so the original authorship is visible in the repository itself.

**Special thanks to [@dimdenGD](https://github.com/dimdenGD).** Ultimate Express is the hard part of this project, and it was already done before Fulmine existed. Everything here stands on that work.

Fulmine is not affiliated with, endorsed by, or maintained by the authors of Ultimate Express. See [`NOTICE`](./NOTICE) for the list of significant changes.

It is likewise not affiliated with the OpenJS Foundation or the Express.js project. Express is a trademark of the OpenJS Foundation.

## Difference from similar projects

- **`ultimate-express`** is what Fulmine is derived from, and is the closest relative by far. It targets Express 4, keeps the v4 API surface and its deprecations. Fulmine targets Express 5 only, which removes the compatibility layer for everything v5 dropped, and is typed. If you are on Express 4, use `ultimate-express`.
- **`hyper-express`** has a similar API but is not a drop-in replacement. It implements much of the functionality differently, which produces quirks that make switching an existing application difficult, and most Express middleware is unsupported.
- **`uwebsockets-express`** is closer to a drop-in replacement, but misses a lot of the API, depends on Express by calling its methods under the hood, and does not use the native µWS router.
- **`express` on Bun** benefits from Bun using µWS for its HTTP module, but performs no µWS-specific optimizations.

## Migrating

In a lot of cases, replacing `require("express")` with `require("fulmine.js")` is the whole migration. `npx fulmine migrate` does that across a project:

```sh
npx fulmine migrate [dir]       # defaults to the current directory
npx fulmine migrate --dry-run   # say what it would rewrite and rewrite nothing
npx fulmine differences         # print the list below and change nothing
```

The command is installed under both `fulmine` and `fulmine.js`. Use `fulmine`: `npx` cannot run a
command whose name ends in `.js` on Windows, where it exits without a word.

## Differences from Express

- `app.listen()` returns the app, not an `http.Server`. There is no node server underneath, so `server.close()`, `server.address()` and anything that attaches itself to a real `http.Server` need a look. `app.close()`, `app.address()` and `app.listening` are there and do what you would expect.
- `x-powered-by` is disabled by default. Express sends `X-Powered-By: Express` unless you turn it off; Fulmine does not send it unless you turn it on with `app.set("x-powered-by", true)`. The header only tells anyone asking which framework is running.
- request body is only read for POST, PUT, PATCH and QUERY requests by default. You can add additional methods by setting `body methods` to array with uppercased methods.
- For HTTPS, instead of doing this:

```js
const https = require("https");
const express = require("express");

const app = express();

https
    .createServer(
        {
            key: fs.readFileSync("path/to/key.pem"),
            cert: fs.readFileSync("path/to/cert.pem")
        },
        app
    )
    .listen(3000, () => {
        console.log("Server is running on port 3000");
    });
```

You have to pass `uwsOptions` to the `express()` constructor:

```js
const express = require("fulmine.js");

const app = express({
    uwsOptions: {
        // https://unetworking.github.io/uWebSockets.js/generated/interfaces/AppOptions.html
        key_file_name: "path/to/key.pem",
        cert_file_name: "path/to/cert.pem"
    }
});

app.listen(3000, () => {
    console.log("Server is running on port 3000");
});
```

- This also applies to non-SSL HTTP too. Use `app.listen()` rather than creating a server by hand. `http.createServer(app)` does work, because the app is a request listener like Express's and answers node's requests through a shim, which is what lets `supertest`, `vhost` and anything else that calls an app keep working. But it serves those requests through `node:http` rather than through µWS, so the speed is Express's. It is there for compatibility, not for production.
- Node.JS max header size is 16384 bytes, while uWebSockets by default is 4096 bytes, so if you need longer headers set the env variable `UWS_HTTP_MAX_HEADERS_SIZE` to max byte count you need.
- uWebSockets drops a request whose body arrives slower than 16KB/s, and the timeout is not reachable from JavaScript, while Node.JS waits as long as the client needs. Uploads over very slow connections can therefore fail here and succeed on Express. A body stalled for 5 seconds still completes; one stalled for 12 seconds gets its socket reset at around 11.8 seconds.

## Performance tips

1. Fulmine tries to optimize routing as much as possible, but it's only possible if:

- the path is a plain string, or its parameters are whole segments: `/users/:id` and `/a/:b/c/:d` qualify, `/flights/:from-:to` does not, and neither does a `*splat` or a `{}` group. Routing is case-insensitive by default, as in Express; a request in the registered case is still served natively, any other case takes the ordinary path, and a route whose overlap with an earlier one leans on a cased literal goes the ordinary way for every request.
- inside a mounted router, nothing registered after the route in that router could match the same path. `/orders/:id`, `/orders/:id/items` and `/invoices/:id` are all optimized together, since no request reaches two of them. `/users/:id` followed by `/users/me` is not: Express answers `/users/me` with the first of the two and the native router would answer it with the second, so both go the ordinary way.

Optimized routes can be up to 10 times faster than normal routes, as they're using native uWS router and have pre-calculated path.

On top of that, a handler simple enough to be read at registration time is compiled into a uWS declarative response and answered natively, without entering JavaScript at all. That needs the route to have nothing in front of it, not a middleware and not a `Router` it was mounted under, and a single handler that only calls `res.status`, `res.set`, `res.append`, `res.send`, `res.json`, `res.sendStatus` or `res.end` with literal arguments, plus `req.params` and `req.query`. Anything else, a variable, a call, an `if`, falls back to ordinary routing. `return res.send(...)` compiles, `res.send(...)` does too, and so does an object or an array of literals however deeply nested. Mounting a `Router` costs only this: the routes inside one are still registered on the native uWS router with their full path, and are as fast as any other optimized route. Three things follow from the response being static:

- it cannot answer `304 Not Modified`. The ETag is still sent, so caches keep working, but a conditional request gets the whole body back rather than an empty 304. Express replies 304 there.
- it is framed as `Transfer-Encoding: chunked` and carries no `Content-Length`, because uWS writes that framing itself.
- it answers `Connection: keep-alive` even to a request that asked for `Connection: close`. The connection is still closed, since uWS decides that itself, and a client that asked to close is closing anyway.

`app.set("declarative responses", false)` turns the whole thing off if you would rather have Express's exact framing than the speed.

2. Do not use external `serve-static` module. Instead use built-in `express.static()` middleware, which is optimized for Fulmine.

3. Do not use `body-parser` module. Instead use built-in `express.text()`, `express.json()` etc.

4. If a route answers with a JSON shape you know in advance, [express-fast-json-stringify](https://www.npmjs.com/package/express-fast-json-stringify) compiles that shape into a serializer and `res.fastJson()` replaces `res.json()`. `JSON.stringify()` has to walk an object it knows nothing about; a compiled serializer does not.

5. Do not set `body methods` to read body of requests with GET method or other methods that don't need a body. Reading body makes endpoint about 15% slower.

6. `app.set("etag", false)` is worth about 8% on small responses, measured on both Fulmine and Express, which pay it almost identically. Know what you are trading: without an ETag a client cannot make a conditional request, so there are no `304 Not Modified` replies and every response is downloaded in full. On anything cacheable the bandwidth a 304 saves is usually worth far more than the 8%. It is left on by default for that reason. Turn it off for an API whose responses are never revalidated.

7. By default, Fulmine creates 1 (or 0 if your CPU has only 1 core) child thread to improve performance of reading files. You can change this number by setting `threads` to a different number in `express()`, or set to 0 to disable thread pool (`express({ threads: 0 })`). Threads are shared between all express() instances, with largest `threads` number being used. Using more threads will not necessarily improve performance. Sometimes not using threads at all is faster, so measure both.

## WebSockets

Since you don't create http server manually, you can't properly use http.on("upgrade") to handle WebSockets. To solve this, there's currently 2 options:

- [Ultimate WS](https://github.com/dimdenGD/ultimate-ws) implements a `ws` compatible API on the same idea: a drop-in replacement for the `ws` module. It was written against Ultimate Express and hooks into the same upgrade mechanism, which Fulmine still exposes, but that combination is not covered by this project's tests. There's a guide for how to upgrade http requests in the documentation.
- You can simply use `app.uwsApp` to access uWebSockets.js `App` instance and call its `ws()` method directly.

### socket.io

socket.io normally takes over the upgrade on a node `http.Server`. There isn't one here, so hand it
the µWS app instead, which socket.io supports natively through `attachApp()`:

```js
const express = require("fulmine.js");
const { Server } = require("socket.io");

const app = express();
const io = new Server();

app.listen(3000);
io.attachApp(app.uwsApp);

io.on("connection", (socket) => {
    socket.on("message", (data) => socket.emit("reply", data));
});
```

`attachApp()` works before or after `app.listen()`. What does not work is `new Server(server)` on the
value `app.listen()` returns: plain HTTP keeps serving, but the WebSocket upgrade fails, because
that object is not a real `http.Server`. This is covered by `tests/tests/middlewares/socket-io.js`,
which runs the same file against Express and against Fulmine and compares the output.

## HTTP/3

HTTP/3 is supported. To use:

```js
const app = express({
    http3: true,
    uwsOptions: {
        key_file_name: "/path/to/example.key",
        cert_file_name: "/path/to/example.crt"
    }
});
```

## Versioning

**The major number tracks Express, not semver.** Fulmine 5.x follows Express 5. If Express 6
arrives, Fulmine goes to 6, and that is the only reason the major ever moves.

Read the rest of the number normally: minor for new behaviour, patch for fixes.

What this costs you: a breaking change can land in a minor. It will be in the changelog under its
own heading, because commits still mark breaking changes the usual way, but the version number
alone will not warn you. If you pin, pin the minor.

## Compatibility

In general, basically all features and options are supported. Use the [Express 5.x documentation](https://expressjs.com/en/5x/api.html) for API reference. Anything Express 5 removed is removed here too, so the list below covers only where this differs from Express 5 itself.

✅ - Full support (all features and options are supported)  
🚧 - Partial support (some options are not supported)  
❌ - Not supported

### express

- ✅ express()
- ✅ express.Router()
- ✅ express.json()
- ✅ express.urlencoded()
- ✅ express.static()
- ✅ express.text()
- ✅ express.raw()
- 🚧 express.request (this is not a constructor but a prototype for replacing methods)
- 🚧 express.response (this is not a constructor but a prototype for replacing methods)
- 🚧 express.application (likewise: a method added here is on every app)
- ✅ express.Route. Both `app.route("/path").get(...).post(...)` and the class itself, for building a route by hand and dispatching to it.

### Application

- ✅ app.listen(port[, host][, callback])
- ✅ app.listen(unix_socket[, callback])
- ✅ app.METHOD() (app.get, app.post, etc.)
- ✅ app.route()
- ✅ app.all()
- ✅ app.use()
- ✅ app.mountpath
- ✅ app.set()
- ✅ app.get()
- ✅ app.enable()
- ✅ app.disable()
- ✅ app.enabled()
- ✅ app.disabled()
- ✅ app.path()
- ✅ app.param(name, callback)
- ✅ app.engine()
- ✅ app.render()
- ✅ app.locals
- ✅ app.settings
- ✅ app.engines
- ✅ app.on("mount")
- ✅ HEAD method
- ✅ OPTIONS method
- ✅ QUERY method

### Application settings

- ✅ case sensitive routing
- ✅ env
- ✅ etag
- ✅ jsonp callback name
- ✅ json escape
- ✅ json replacer
- ✅ json spaces
- ✅ query parser
- ✅ strict routing
- ✅ subdomain offset
- ✅ trust proxy
- ✅ views
- ✅ view cache
- ✅ view engine
- ✅ x-powered-by

Two of these keep a compiled form alongside the value, which you can also set directly:

- `etag fn`, the function that produces an ETag. Setting `etag` compiles one; setting this replaces it.
- `query parser fn`, likewise for `query parser`.

Fulmine adds one of its own:

- `declarative responses`, on by default. Lets a simple enough handler be compiled into a native uWS response, described under [Performance tips](#performance-tips).

### Request

- ✅ implements Readable stream
- ✅ req.app
- ✅ req.baseUrl
- ✅ req.body
- ✅ req.cookies
- ✅ req.fresh
- ✅ req.hostname
- ✅ req.header
- ✅ req.headers
- ✅ req.headersDistinct
- ✅ req.rawHeaders
- ✅ req.ip
- ✅ req.ips
- ✅ req.method
- ✅ req.url
- ✅ req.originalUrl
- ✅ req.params
- ✅ req.path
- ✅ req.protocol
- ✅ req.query
- ✅ req.res
- ✅ req.secure
- ✅ req.signedCookies
- ✅ req.stale
- ✅ req.subdomains
- ✅ req.xhr
- 🚧 req.route (route implementation is different from Express)
- 🚧 req.connection, req.socket (only `end()`, `encrypted`, `remoteAddress`, `remotePort` and `localPort` are supported)
- ✅ req.accepts()
- ✅ req.acceptsCharsets()
- ✅ req.acceptsEncodings()
- ✅ req.acceptsLanguages()
- ✅ req.get()
- ✅ req.is()
- ✅ req.range()

### Response

- ✅ implements Writable stream
- ✅ res.app
- ✅ res.headersSent
- ✅ res.req
- ✅ res.locals
- ✅ res.append()
- ✅ res.attachment()
- ✅ res.cookie()
- ✅ res.clearCookie()
- ✅ res.download()
- ✅ res.end()
- ✅ res.format()
- ✅ res.getHeader(), res.get()
- ✅ res.json()
- ✅ res.jsonp()
- ✅ res.links()
- ✅ res.location()
- ✅ res.redirect()
- ✅ res.render()
- ✅ res.send()
- ✅ res.sendFile()
-   - ✅ options.maxAge
-   - ✅ options.root
-   - ✅ options.lastModified
-   - ✅ options.headers
-   - ✅ options.dotfiles
-   - ✅ options.acceptRanges
-   - ✅ options.cacheControl
-   - ✅ options.immutable
-   - ✅ Range header
-   - ✅ Setting ETag header
-   - ✅ If-Match header
-   - ✅ If-Modified-Since header
-   - ✅ If-Unmodified-Since header
-   - ✅ If-Range header
- ✅ res.sendStatus()
- ✅ res.header(), res.setHeader(), res.set()
- ✅ res.status()
- ✅ res.type()
- ✅ res.vary()
- ✅ res.removeHeader()
- ✅ res.write()
- ✅ res.writeHead()

### Router

- ✅ router.all()
- ✅ router.METHOD() (router.get, router.post, etc.)
- ✅ router.route()
- ✅ router.use()
- ✅ router.param(name, callback)
- ✅ options.caseSensitive
- ✅ options.strict
- ✅ options.mergeParams

## Tested middlewares

Almost all middlewares that are compatible with Express are compatible with Fulmine. Here's list of middlewares that we test for compatibility:

- ✅ [express-fast-json-stringify](https://npmjs.com/package/express-fast-json-stringify)
- ✅ [socket.io](https://npmjs.com/package/socket.io) (via `io.attachApp(app.uwsApp)`, see WebSockets above)
- ✅ [body-parser](https://npmjs.com/package/body-parser) (use `express.text()` etc instead for better performance)
- ✅ [cookie-parser](https://npmjs.com/package/cookie-parser)
- ✅ [cookie-session](https://npmjs.com/package/cookie-session)
- ✅ [compression](https://npmjs.com/package/compression)
- ✅ [serve-static](https://npmjs.com/package/serve-static) (use `express.static()` instead for better performance)
- ✅ [serve-index](https://npmjs.com/package/serve-index)
- ✅ [cors](https://npmjs.com/package/cors)
- ✅ [errorhandler](https://npmjs.com/package/errorhandler)
- ✅ [method-override](https://npmjs.com/package/method-override)
- ✅ [multer](https://npmjs.com/package/multer)
- ✅ [response-time](https://npmjs.com/package/response-time)
- ✅ [express-fileupload](https://npmjs.com/package/express-fileupload)
- ✅ [express-session](https://npmjs.com/package/express-session)
- ✅ [express-rate-limit](https://npmjs.com/package/express-rate-limit)
- ✅ [express-subdomain](https://npmjs.com/package/express-subdomain)
- ✅ [vhost](https://npmjs.com/package/vhost)
- ✅ [tsoa](https://github.com/lukeautry/tsoa)
- ✅ [express-mongo-sanitize](https://www.npmjs.com/package/express-mongo-sanitize)
- ✅ [helmet](https://www.npmjs.com/package/helmet)
- ✅ [passport](https://www.npmjs.com/package/passport)
- ✅ [morgan](https://www.npmjs.com/package/morgan)
- ✅ [swagger-ui-express](https://www.npmjs.com/package/swagger-ui-express)
- ✅ [graphql-http](https://www.npmjs.com/package/graphql-http)
- ✅ [better-sse](https://www.npmjs.com/package/better-sse)
- ✅ [supertest](https://www.npmjs.com/package/supertest)

## Tested view engines

Any Express view engine should work. Here's list of engines we include in our test suite:

- ✅ [ejs](https://npmjs.com/package/ejs)
- ✅ [pug](https://npmjs.com/package/pug)
- ✅ [express-dot-engine](https://npmjs.com/package/express-dot-engine)
- ✅ [express-art-template](https://npmjs.com/package/express-art-template)
- ✅ [express-handlebars](https://npmjs.com/package/express-handlebars)
- ✅ [swig](https://npmjs.com/package/swig)

## Working on Fulmine

```sh
npm test                  # the comparison suite: every test runs against Express, then against
                          # Fulmine, and the two outputs have to match byte for byte
npm test middlewares      # one category
npm test tests/tests/res/res-send.js   # one file

npm run test:unit         # the pure functions, which the comparison cannot reach
npm run test:types        # the TypeScript declarations, through tsd
npm run typecheck         # checkJs over src, which is where the JSDoc types are checked

npm run lint              # eslint, including the rule that every function in src carries a JSDoc block
npm run format            # prettier
npm run cover             # the comparison suite under nyc, then an HTML report

npm run benchmark:compare -- --duration 20      # against Express, scenario by scenario
npm run benchmark:ab -- --against main          # this working tree against another revision

npm run test:express                            # Express's own test suite, run against this
npm run test:express -- res.sendFile --verbose  # one area of it, with mocha's output
```

The comparison suite is the load-bearing one. A test is a file that prints; the runner executes it
twice, once with `express` and once with this, and fails on any difference. That is why adding a
test means writing something that prints what you want compared, and why a test that prints from
both the server and the client at once is a bug: the two orderings are a race.

### Writing a comparison test

A test file is an ordinary script. The first line is its description, the second may carry a marker,
and the rest sets up an app, makes requests and prints. `tests/helpers.js` has what to print with:

|                         |                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchTest(url, init)`  | `fetch`, plus a line with the status and the headers worth comparing. Returns the response untouched, so the test goes on to read the body as it would have. Lines come out in call order, never in arrival order.                                          |
| `sequential([() => …])` | Runs requests one at a time. `Promise.all` starts them together and the two servers then answer in whatever order they scheduled, which is a difference the runner would report as a failure.                                                               |
| `// INSPECT`            | On the second line. The runner then mounts `inspectRequest` in front of every app the file makes, and each request prints its `method`, `url`, `originalUrl`, `baseUrl`, `path`, `protocol`, `secure`, `hostname`, `host`, `xhr`, `subdomains` and `query`. |
| `// OFF: reason`        | Skips the file.                                                                                                                                                                                                                                             |

`// INSPECT` is not free everywhere, which is why it is asked for rather than always on. It is a
middleware, so a route behind it stops being compiled into a declarative response and is served by
the ordinary path instead: a file whose routes do compile would quietly stop covering the compiled
one. And Express builds its router at the first `use()`, freezing `strict routing` and
`case sensitive routing` as they are at that moment, so a file that sets either one afterwards must
not ask for it. Everywhere else it is worth having: it is what caught a pathless mount dropping the
middleware in front of it.

`npm run test:express` is the other kind of test: it clones Express at the version in
`devDependencies`, points its entry at this source and runs its suite against it. It is a bug mine
rather than a gate, and its exit status says nothing. Read the header of `tools/express-suite.js`
before reading its numbers: some of what it reports is Express testing its own internals, which the
clone still has, and some is internals used as public API.

`benchmark/README.md` covers measuring, including why the A/B runs pipelined by default and why a
null control matters.
