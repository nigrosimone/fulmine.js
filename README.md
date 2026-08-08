<img src="./assets/logo-mark.svg" alt="" width="88" align="right">

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
npx fulmine profile             # what listen() decided about each route
```

See [Migrating](#migrating) for what it handles and what it deliberately does not.

There is a **[live demo](https://fulmine-demo.fly.dev)**: a real Angular 22 application, server-side
rendered, with `helmet`, `cors`, `compression`, `express-session` and `morgan` unmodified in front of
it, its rendered HTML kept by [ng-ssr-caching](https://www.npmjs.com/package/ng-ssr-caching), and a
WebSocket chat served by `app.ws()`. The source is [in this repository](./demo). It shows no
throughput figure on purpose: it runs on a small shared machine, so the number would describe the
machine rather than the framework.

[![npm version](https://img.shields.io/npm/v/fulmine.js)](https://www.npmjs.com/package/fulmine.js)
[![Node.js >= 22.0.0](https://img.shields.io/badge/Node.js-%3E=22.0.0-green)](https://nodejs.org)
[![Coverage Status](https://coveralls.io/repos/github/nigrosimone/fulmine.js/badge.svg?branch=main)](https://coveralls.io/github/nigrosimone/fulmine.js?branch=main)
[![CodeQL](https://github.com/nigrosimone/fulmine.js/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/nigrosimone/fulmine.js/actions/workflows/codeql.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

## Table of contents

- [Why this exists](#why-this-exists)
- [Performance](#performance)
- [Public benchmarks](#public-benchmarks)
- [Attribution](#attribution)
- [Difference from similar projects](#difference-from-similar-projects)
- [Migrating](#migrating)
    - [Angular SSR](#angular-ssr)
    - [When Express is somebody else's dependency](#when-express-is-somebody-elses-dependency)
- [Docker](#docker)
- [Differences from Express](#differences-from-express)
- [Performance tips](#performance-tips)
- [WebSockets](#websockets)
    - [socket.io](#socketio)
- [HTTP/3](#http3)
- [Behind a proxy](#behind-a-proxy)
- [Versioning](#versioning)
- [Compatibility](#compatibility)
    - [express](#express)
    - [Application](#application)
    - [Application settings](#application-settings)
    - [Request](#request)
    - [Response](#response)
    - [Router](#router)
- [Tested middlewares](#tested-middlewares)
- [Tested view engines](#tested-view-engines)
- [The demo](https://fulmine-demo.fly.dev)
- [Working on Fulmine](./CONTRIBUTING.md)

## Why this exists

There are several fast HTTP servers for Node built on [µWebSockets.js](https://github.com/uNetworking/uWebSockets.js). What is scarce is one you can actually drop into an existing Express application without rewriting it.

Compatibility here is not a claim, it is a test suite. Every test runs against real Express first and then against Fulmine, and the outputs have to match byte for byte. That is what makes `helmet`, `cors`, `passport`, `morgan`, `multer`, `express-session` and the rest of the ecosystem work rather than "mostly work". Express 5's own test suite runs against Fulmine too, and passes whole: 1130 passing, 0 failing at the pinned Express version.

## Performance

Fulmine is faster than Express where the framework itself is doing the work, and the same speed where it is not. Both halves of that sentence matter, so here is the honest version.

**Where it is clearly faster.** Routing and dispatch, request shapes with params and query strings, connection handling. Plain routing lands between 1.9x and 4.3x: hello-world 1.9x to 2.2x, an API endpoint with params and a query 3.2x to 4.3x, five route shapes served by one process 2.5x to 3.3x, nested routers 2.1x to 3.1x, a urlencoded body 3.4x to 4.1x, a thousand concurrent connections 2.7x to 3.2x. Route tables are where the native router shows: a thousand routes 9.7x to 12.9x, with a parameter in every one of them 10.4x to 14x, a parameterised route in a mounted router 7.1x to 8.3x. Those routes go to µWS's own router instead of being scanned, so the gap grows with the table instead of shrinking. Even the chain of 100 middlewares, for a long time the one routing row that stayed even because its cost is calling application code a hundred times, sits at 1.5x to 1.7x after the per-request work of August 2026.

**Where it is a wash.** Any request whose cost is dominated by work both servers hand to the same library. A 512 KiB JSON body is `JSON.parse`, a gzipped response is zlib, a hashed upload is OpenSSL, a 5 MiB stream is memory bandwidth. On those the ratio is capped by arithmetic somewhere around 1.0x to 1.2x, and no amount of work on either server moves it. The benchmark labels those rows rather than quietly publishing them as if the two were equivalent.

Two things worth knowing before comparing numbers with anyone:

- **Node 24 moved the baseline.** Express got roughly 3x faster on the routing benchmarks between Node 22 and Node 24, while a µWS-based server barely moved, because the gain came from `node:http`. Any comparison published before mid-2026 overstates the current gap.
- **Ratios are not portable across runs.** GitHub's runners vary enough that the same code measures 15k or 28k req/sec on the same row. Only compare figures produced in the same run.

There is no table here on purpose. CI runs the whole benchmark on every push and every pull request
and posts the result where it belongs: as a comment on the commit or the pull request, and as a
`benchmark-summary` artifact on the run, see [`benchmark/README.md`](./benchmark/README.md)
to run it yourself.

## Public benchmarks

Numbers produced by a project about itself deserve suspicion, so Fulmine also stands in public arenas, run by their own rigs under their own rules:

- **[HttpArena](https://www.http-arena.com/#sort=rps:-1&q=Js)** (the link lands filtered on the JavaScript entries): first among the JavaScript entries, across fifteen subscribed profiles. The saved runs measure 24.3 million WebSocket echoes per second pipelined and 3.77 million one-at-a-time (past Bun's own dedicated WebSocket entry), 7.3 million pipelined HTTP requests per second, 1.12 million on the json profile with 1.04 million of that surviving TLS, 457 thousand on compressed json, and 359 thousand on the Postgres CRUD profile, within ten percent of the leading Rust and C# entries there.
- **[web-frameworks](https://web-frameworks-benchmark.netlify.app/result?l=javascript)**: entry merged, numbers arrive with their next published round.

More to come as their maintainers take the entries in.

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

### Angular SSR

The `server.ts` that `ng add @angular/ssr` generates is an ordinary Express application, so the same
one-line change applies, and `@angular/ssr`'s own `AngularNodeAppEngine` and
`writeResponseToNodeResponse` work against Fulmine's request and response unchanged. One extra step
is needed, and it is Angular's build rather than this library: the server bundle is built with
esbuild, which tries to inline every dependency and cannot load µWS's native binary. Declare the two
as external in `angular.json`:

```json
"architect": { "build": { "options": {
    "externalDependencies": ["fulmine.js", "uWebSockets.js"]
} } }
```

What it is worth, measured on an Angular 22 application with each server reporting its own CPU per
request, nine alternating rounds: **static assets 3.29x**, and **a page served from a cache 1.50x**.
The render itself is the same JavaScript on both sides and measures the same, so on a cache miss the
framework is not what your page is waiting for. Which is the useful way round: an SSR application
spends most of its traffic outside the render, and that is where the difference is.

Caching those pages is [`ng-ssr-caching`](https://www.npmjs.com/package/ng-ssr-caching), a middleware
that runs on Express and here alike, and the same measurement says a page costs 17.2ms to render and
1.9ms to serve from it. It is worth knowing why it keeps the ETag beside the bytes: a cache that
stores only the body makes the server hash the whole document again on every hit, and measures level
with no cache at all on the serving side.

### When Express is somebody else's dependency

A framework built on Express does not `require("express")` in your code, it requires it in its own,
so there is nothing for `migrate` to rewrite. Every package manager can answer `express` with this
package instead, for your project and everything under it:

```jsonc
// npm and its lockfile, in package.json
{
    "overrides": {
        "express": "npm:fulmine.js@^5"
    }
}

// pnpm, in package.json
{
    "pnpm": {
        "overrides": {
            "express": "npm:fulmine.js@^5"
        }
    }
}

// yarn 1 and berry, in package.json
{
    "resolutions": {
        "express": "npm:fulmine.js@^5"
    }
}
```

Then reinstall, so the lockfile is rewritten: `rm -rf node_modules` and `npm install`, or the
equivalent for your manager. `npm ls express` should answer `express@npm:fulmine.js`.

Two things to know before you do it. The substitution reaches **every** dependency that asks for
Express, including ones you have never looked at, so run your own tests afterwards and read
[the differences](#differences-from-express): what a framework does with Express is usually more
than what an application does. And a package that reaches into `express/lib/...` rather than its
public surface will not find what it expects, since the files there are ours.

Bun is not an option: µWebSockets.js is a native Node addon, and Bun does not load it.

## Docker

Two things about µWebSockets.js make a Dockerfile that works for Express fail here, and both have easy answers:

- **No Alpine, and no Debian bookworm either.** µWebSockets.js ships prebuilt binaries linked against glibc 2.38 or newer. Alpine images use musl, so the binary does not load at all; `node:26` and `node:26-slim` are Debian bookworm, whose glibc 2.36 fails at startup with `GLIBC_2.38' not found`. Use the trixie variants: `node:26-trixie-slim` and up.
- **`git` must be there when `npm install` runs.** µWebSockets.js is not on npm; it is installed straight from GitHub (`github:uNetworking/uWebSockets.js`), and npm uses git to fetch it. Full images like `node:26-trixie` have git; `-slim` ones do not.

The clean way to satisfy both is a multi-stage build: install with the full image, run with the slim one.

```dockerfile
FROM node:26-trixie AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:26-trixie-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

A single-stage `node:26-trixie-slim` image works too if you `apt-get install -y git ca-certificates` before `npm ci`. Prebuilt binaries exist for x64 and arm64 on Linux, macOS and Windows, so nothing is compiled at install time either way.

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

Two more things happen on the way in, and `npx fulmine profile` will tell you which of them your
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

- the path is a plain string, or its parameters are whole segments: `/users/:id` and `/a/:b/c/:d` qualify, `/flights/:from-:to` does not, and neither does a `*splat` or a `{}` group. Routing is case-insensitive by default, as in Express; a request in the registered case is still served natively, any other case takes the ordinary path, and a route whose overlap with an earlier one leans on a cased literal goes the ordinary way for every request.
- inside a mounted router, nothing registered after the route in that router could match the same path. `/orders/:id`, `/orders/:id/items` and `/invoices/:id` are all optimized together, since no request reaches two of them. `/users/:id` followed by `/users/me` is not: Express answers `/users/me` with the first of the two and the native router would answer it with the second, so both go the ordinary way.

Optimized routes can be up to 10 times faster than normal routes, as they're using native uWS router and have pre-calculated path.

On top of that, a handler simple enough to be read at registration time is compiled into a uWS declarative response and answered natively, without entering JavaScript at all. That needs the route to have nothing in front of it, not a middleware and not a `Router` it was mounted under, and a single handler that only calls `res.status`, `res.set`, `res.append`, `res.send`, `res.json`, `res.sendStatus` or `res.end` with literal arguments, plus `req.params` and `req.query`. Anything else, a variable, a call, an `if`, falls back to ordinary routing. `return res.send(...)` compiles, `res.send(...)` does too, and so does an object or an array of literals however deeply nested. Mounting a `Router` costs only this: the routes inside one are still registered on the native uWS router with their full path, and are as fast as any other optimized route. Three things follow from the response being static:

- it cannot answer `304 Not Modified`. The ETag is still sent, so caches keep working, but a conditional request gets the whole body back rather than an empty 304. Express replies 304 there.
- it is framed as `Transfer-Encoding: chunked` and carries no `Content-Length`, because uWS writes that framing itself.
- it answers `Connection: keep-alive` even to a request that asked for `Connection: close`. The connection is still closed, since uWS decides that itself, and a client that asked to close is closing anyway.

`app.set("declarative responses", false)` turns the whole thing off if you would rather have Express's exact framing than the speed.

None of that is guesswork you have to do from the outside. `listen()` decides it all, and `npx fulmine profile` prints what it decided:

```sh
npx fulmine profile              # the file package.json's "main" points at
npx fulmine profile server.js    # or name it
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

2. Do not use external `serve-static` module. Instead use built-in `express.static()` middleware, which is optimized for Fulmine.

3. Do not use `body-parser` module. Instead use built-in `express.text()`, `express.json()` etc.

4. If a route answers with a JSON shape you know in advance, [express-fast-json-stringify](https://www.npmjs.com/package/express-fast-json-stringify) compiles that shape into a serializer and `res.fastJson()` replaces `res.json()`. `JSON.stringify()` has to walk an object it knows nothing about; a compiled serializer does not.

5. Do not set `body methods` to read body of requests with GET method or other methods that don't need a body. Reading body makes endpoint about 15% slower.

6. `app.set("etag", false)` is worth about 8% on small responses, measured on both Fulmine and Express, which pay it almost identically. Know what you are trading: without an ETag a client cannot make a conditional request, so there are no `304 Not Modified` replies and every response is downloaded in full. On anything cacheable the bandwidth a 304 saves is usually worth far more than the 8%. It is left on by default for that reason. Turn it off for an API whose responses are never revalidated.

7. By default, Fulmine creates 1 (or 0 if your CPU has only 1 core) child thread to improve performance of reading files. You can change this number by setting `threads` to a different number in `express()`, or set to 0 to disable thread pool (`express({ threads: 0 })`). Threads are shared between all express() instances, with largest `threads` number being used. Using more threads will not necessarily improve performance. Sometimes not using threads at all is faster, so measure both.

## WebSockets

`app.ws()` registers a WebSocket route, served by µWS itself. There is no `http.Server` underneath, so `http.on("upgrade")` and the libraries built on it do not apply; this is the replacement.

```js
app.ws("/room/:id", {
    upgrade(req, res) {
        // runs before the handshake, with a real request and response.
        // Answering the response declines the socket:
        if (!req.query.token) return res.sendStatus(401);
        // and anything left on the request is there for the socket's whole life:
        req.room = req.params.id;
    },
    open(ws) {
        ws.subscribe(ws.req.room);
    },
    message(ws, message, isBinary) {
        ws.publish(ws.req.room, message, isBinary);
    },
    close(ws, code, message) {}
});
```

- **The behavior object is µWS's**, settings included: `maxPayloadLength`, `idleTimeout`, `compression`, `maxBackpressure`, `sendPingsAutomatically` and the rest are passed through untouched, as are the `open`, `message`, `drain`, `close`, `ping`, `pong`, `dropped` and `subscription` handlers. The socket is µWS's too, so `send`, `subscribe`, `publish`, `cork` and `getBufferedAmount` behave exactly as its documentation describes.
- **`upgrade(req, res)` is this project's addition.** It runs before the handshake with the same `Request` and `Response` your routes get, so a session, a token or a header decides whether the socket opens. Answering the response, with `res.sendStatus(401)` or any other write, declines the upgrade. Returning a promise holds the handshake until it settles, which is what an authentication lookup needs.
- **`ws.req` is that request**, and it outlives the response: the client's address, headers, query and params are readable from any handler for as long as the socket is open. Hanging your own values on it in `upgrade` is how per-connection state gets to `message`.
- **Routers work.** `router.ws("/lobby", …)` mounted with `app.use("/chat", router)` serves `/chat/lobby`.
- **Paths are the ones µWS matches**: literal, or with parameters that are a whole segment such as `/room/:id`. Anything else throws where it is written rather than failing to match later.
- **Broadcasting from outside a socket**: `app.publish(topic, message)` and `app.numSubscribers(topic)`.

A WebSocket route and an ordinary route can share a path: the upgrade goes to the WebSocket route, a plain GET goes through normal routing.

If you would rather use the `ws` module's API, [Ultimate WS](https://github.com/dimdenGD/ultimate-ws) is a drop-in replacement for it written against Ultimate Express, and Fulmine still exposes the mechanism it hooks into, but that combination is not covered by this project's tests. `app.uwsApp` also remains available for anything µWS offers that this does not.

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

There is an `http3: true` option, inherited from Ultimate Express, that asks µWebSockets.js for its experimental HTTP/3 app. **It is guarded off with the currently pinned µWS build**: asking for it throws a clear error, because the underlying `H3App` segfaults during construction on Linux, verified with µWS alone before a single request is served. On Windows the listener does come up, but nothing answers over QUIC that we could verify, and shipping an option that works on no deployable platform helps nobody. A skipped canary test probes `H3App` on every CI run and will turn red the day µWS ships working QUIC in its prebuilt binaries, which is when the guard goes and this section changes.

```js
// what it would look like, once µWS's H3 support actually works
const app = express({
    http3: true,
    uwsOptions: {
        key_file_name: "/path/to/example.key",
        cert_file_name: "/path/to/example.crt"
    }
});
```

## Behind a proxy

`trust proxy` works as it does in Express: set it and `req.ip`, `req.ips`, `req.protocol` and
`req.hostname` are read from `X-Forwarded-*` when the connection comes from a peer you trust.

Fulmine adds the other way of being told, the one that does not use headers at all. HAProxy, AWS
NLB, nginx with `proxy_protocol` and Envoy can prepend a **PROXY protocol** preamble to the
connection, and µWebSockets.js parses it. Off by default, and one line turns it on:

```js
app.set("trust proxy protocol", true);
// req.ip, req.socket.remoteAddress and everything reading them are now the address the proxy
// declared, and fall back to the socket's own on a connection that sent no preamble
```

> [!WARNING]
> **Only turn this on when nothing but the proxy can reach the server.** µWS reads the preamble
> from whoever sends it. There is no way to say which peers may use it, so on a port open to the
> internet the first sixteen bytes of any connection are enough for a client to become `10.0.0.1`
> for your rate limiter, your allow list and your audit log. Bind to the private interface, or
> keep this off.

`trust proxy` and this can both be on. The preamble decides what the connection's address is, and
`trust proxy` then peels `X-Forwarded-For` off that, so a proxy that sends both is read the way it
meant.

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

Fulmine adds three of its own:

- `declarative responses`, on by default. Lets a simple enough handler be compiled into a native uWS response, described under [Performance tips](#performance-tips).
- `file cache`, on by default. Small files served by `res.sendFile` come from a bounded in-process cache, checked against the file's `stat` on every request, so an edited file is never served stale.
- `trust proxy protocol`, off by default. Takes `req.ip` from a PROXY protocol preamble, described under [Behind a proxy](#behind-a-proxy). Read the warning there before turning it on.

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
- ✅ res.flushHeaders()

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
- ✅ [http-proxy-middleware](https://www.npmjs.com/package/http-proxy-middleware)
- ✅ [express-http-proxy](https://www.npmjs.com/package/express-http-proxy)
- ✅ [express-mongo-sanitize](https://www.npmjs.com/package/express-mongo-sanitize)
- ✅ [helmet](https://www.npmjs.com/package/helmet)
- ✅ [passport](https://www.npmjs.com/package/passport)
- ✅ [morgan](https://www.npmjs.com/package/morgan)
- ✅ [swagger-ui-express](https://www.npmjs.com/package/swagger-ui-express)
- ✅ [graphql-http](https://www.npmjs.com/package/graphql-http)
- ✅ [better-sse](https://www.npmjs.com/package/better-sse)
- ✅ [supertest](https://www.npmjs.com/package/supertest)

[tsoa](https://github.com/lukeautry/tsoa) works too, but it is not in the suite above: it resolves
`express` itself, so testing it here needs a dependency override rather than the one-line swap
everything else takes.

## Tested view engines

Any Express view engine should work. Here's list of engines we include in our test suite:

- ✅ [ejs](https://npmjs.com/package/ejs)
- ✅ [pug](https://npmjs.com/package/pug)
- ✅ [express-dot-engine](https://npmjs.com/package/express-dot-engine)
- ✅ [express-art-template](https://npmjs.com/package/express-art-template)
- ✅ [express-handlebars](https://npmjs.com/package/express-handlebars)
- ✅ [swig](https://npmjs.com/package/swig)

## Working on Fulmine

How to run the suites, what each of them is for, and how to write a comparison test:
[`CONTRIBUTING.md`](./CONTRIBUTING.md).
