<img src="./assets/logo-mark.svg" alt="" width="88" align="right">

# Fulmine.js

Fulmine - means lightning ⚡ in Italian - is a drop-in replacement for Express 5, running on [µWebSockets.js](https://github.com/uNetworking/uWebSockets.js) instead of `node:http`. Your existing middleware keeps working.

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
npx fulmine.js verify              # can this machine and this image even run it
npx fulmine.js migrate --dry-run   # say what it would change, change nothing
npx fulmine.js migrate             # do it
npx fulmine.js override            # when a framework requires express in its own code, not in yours
npx fulmine.js angular             # angular.json's server build, which esbuild would otherwise inline
npx fulmine.js differences         # just the list of what to check by hand
npx fulmine.js profile             # what listen() decided about each route
npx fulmine.js explain /api/items  # what happens when a request for that route arrives
```

See [Migrating](#migrating) for what it handles and what it deliberately does not.

[![npm version](https://img.shields.io/npm/v/fulmine.js)](https://www.npmjs.com/package/fulmine.js)
[![Node.js 22 | 24 | 26](https://img.shields.io/badge/Node.js-22%20%7C%2024%20%7C%2026-green)](https://nodejs.org)
[![HTTP Arena](https://img.shields.io/endpoint?url=https://www.http-arena.com/badge/fulmine/h1.json)](https://www.http-arena.com/#tuned=0)
[![Coverage Status](https://coveralls.io/repos/github/nigrosimone/fulmine.js/badge.svg?branch=main)](https://coveralls.io/github/nigrosimone/fulmine.js?branch=main)
[![CodeQL](https://github.com/nigrosimone/fulmine.js/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/nigrosimone/fulmine.js/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/nigrosimone/fulmine.js/badge)](https://scorecard.dev/viewer/?uri=github.com/nigrosimone/fulmine.js)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14089/badge)](https://www.bestpractices.dev/projects/14089)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

## Table of contents

- [Why this exists](#why-this-exists)
- [Performance](#performance)
- [Public benchmarks](#public-benchmarks)
- [Attribution](#attribution)
- [Difference from similar projects](#difference-from-similar-projects)
- [Migrating](#migrating)
    - [Angular SSR](#angular-ssr)
    - [NestJS](#nestjs)
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
- [Examples](./examples/README.md)
- [Working on Fulmine](./CONTRIBUTING.md)

## Why this exists

There are several fast HTTP servers for Node built on [µWebSockets.js](https://github.com/uNetworking/uWebSockets.js). What is scarce is one you can actually drop into an existing Express application without rewriting it.

Compatibility here is not a claim, it is a test suite. Every test runs against real Express first and then against Fulmine, and the outputs have to match byte for byte. That is what makes `helmet`, `cors`, `passport`, `morgan`, `multer`, `express-session` and the rest of the ecosystem work rather than "mostly work". Express 5's own test suite runs against Fulmine too, and passes whole: 1130 passing, 0 failing at the pinned Express version.

## Performance

Fulmine is faster than Express where the framework itself is doing the work, and the same speed where it is not. Both halves of that sentence matter, so here is the honest version.

**Where it is clearly faster.** Routing and dispatch, request shapes with params and query strings, connection handling. The spreads below are the last nine CI runs, which landed on three different runner shapes, all on Node 26. Plain routing lands between 1.8x and 4.9x: hello-world 1.8x to 2.9x, an API endpoint with params and a query 3.1x to 4.9x, five route shapes served by one process 2.4x to 4.0x, nested routers 2.0x to 3.4x, a urlencoded body 3.3x to 4.6x, a thousand concurrent connections 2.6x to 3.7x. Route tables are where the native router shows: a thousand routes 9.7x to 17.4x, with a parameter in every one of them 10x to 21.2x, a parameterised route in a mounted router 6.8x to 8.8x. Those routes go to µWS's own router instead of being scanned, so the gap grows with the table instead of shrinking. Even the chain of 100 middlewares, for a long time the one routing row that stayed even because its cost is calling application code a hundred times, sits at 1.7x to 2.1x after the per-request work of August 2026.

**Where it is a wash.** Any request whose cost is dominated by work both servers hand to the same library. A 512 KiB JSON body is `JSON.parse`, a gzipped response is zlib, a hashed upload is OpenSSL, a 5 MiB stream is memory bandwidth. On those the ratio is capped by arithmetic somewhere between 1.0x and 1.5x, depending on how much of the request is the shared work, and no amount of effort on either server moves it. The benchmark labels those rows rather than quietly publishing them as if the two were equivalent.

Two things worth knowing before comparing numbers with anyone:

- **Node 24 moved the baseline.** Express got roughly 3x faster on the routing benchmarks between Node 22 and Node 24, while a µWS-based server barely moved, because the gain came from `node:http`. Any comparison published before mid-2026 overstates the current gap.
- **Ratios are not portable across runs.** GitHub's runners vary enough that the same code measures 15k or 28k req/sec on the same row. Only compare figures produced in the same run.

There is no table here on purpose. CI runs the whole benchmark on every push and every pull request
and posts the result where it belongs: as a comment on the commit or the pull request, and as a
`benchmark-summary` artifact on the run, see [`benchmark/README.md`](./benchmark/README.md)
to run it yourself.

## Public benchmarks

Numbers produced by a project about itself deserve suspicion, so Fulmine also stands in public arenas, run by their own rigs under their own rules:

- **[HttpArena](https://www.http-arena.com/#sort=rps:-1&q=Js)**: thirty profiles on 64-core dedicated hardware, same conditions for every entry, rerun whenever one of them changes. The link lands filtered on the JavaScript entries. No figures are copied here on purpose: the board is the current one and this page would not be.
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

In a lot of cases, replacing `require("express")` with `require("fulmine.js")` is the whole migration. `npx fulmine.js migrate` does that across a project:

```sh
npx fulmine.js migrate [dir]       # defaults to the current directory
npx fulmine.js migrate --dry-run   # say what it would rewrite and rewrite nothing
npx fulmine.js differences         # print the list below and change nothing
```

It also names the middlewares it found that have a faster one built in here, `compression`,
`body-parser` and `serve-static`, and leaves them to you: the replacement is reached through the
`express` import, and no rewrite can know that it is in scope where they are required.

`npx fulmine.js verify` is the question that comes before all of that: whether this machine, and the
image this will be deployed in, can run it at all. There is a µWebSockets.js binary underneath, and
a binary is built per platform, per architecture and per node ABI, and linked against glibc. An
Alpine base, a node version the pinned build has no binary for, a `FROM node:20-alpine` written
years ago: each one fails at require time, in a container, with a message about a missing module.
This says so in thirty seconds, and exits non-zero when something would stop the start.

```text
  ok    Node 22.15.0
  ok    glibc 2.39
  ok    µWebSockets.js binary for linux x64, node ABI 127
  NO    Dockerfile: node:20-alpine
        musl, and there is no musl build: node:22-trixie-slim is the closest swap.
  note  socket.io needs a different API here
        attach it with io.attachApp(app.uwsApp), not io.attach(server)
```

### Angular SSR

The `server.ts` that `ng add @angular/ssr` generates is an ordinary Express application, so the same
one-line change applies, and `@angular/ssr`'s own `AngularNodeAppEngine` and
`writeResponseToNodeResponse` work against Fulmine's request and response unchanged. One extra step
is needed, and it is Angular's build rather than this library: the server bundle is built with
esbuild, which tries to inline every dependency and cannot load µWS's native binary. The two names
have to be declared external in `angular.json`, which is what this writes:

```sh
npx fulmine.js angular             # every server build in angular.json
npx fulmine.js angular --dry-run   # say what it would write, write nothing
```

It adds this to each build target that produces a server bundle, and leaves the browser-only ones
alone:

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

### NestJS

`@nestjs/platform-express` takes an Express instance, so it takes this one, and everything in a Nest
application keeps working. The adapter is in the package, so there is nothing to write:

```ts
import { NestFactory } from "@nestjs/core";
import { FulmineExpressAdapter } from "fulmine.js/nest";

const app = await NestFactory.create(AppModule, new FulmineExpressAdapter());
await app.listen(3000);
```

Pass your own application where it needs options, TLS being the usual reason:
`new FulmineExpressAdapter(fulmine({ uwsOptions }))`. `@nestjs/platform-express` is an optional peer
dependency, so nothing is installed for anyone who never imports this.

What it changes is one line and two edges. The line: Nest's own adapter wraps whatever instance it
is given in `http.createServer()` and listens on that, which is the shim, so every request goes
through `node:http` and the application runs at Express's pace. The app here already answers as an
`http.Server`, so it is the server rather than being put inside one. The edges:
`forceCloseConnections` has nothing to destroy, since the sockets belong to µWS and nothing emits
`connection`, so it now says so instead of quietly doing nothing; and Nest decides whether it has
already added its body parsers by scanning `app.router.stack`, which is not there, so the adapter
remembers instead of letting a second call add a second pair. `httpsOptions` is refused rather than
silently starting a plaintext server: TLS is configured on the app, through `uwsOptions`.

Measured on the same Nest application, controllers, pipes and body parsing unchanged: **1.2x on a
route answering text and 1.9x on one answering JSON with a route parameter**. `app.close()` closes
the port, as it does on the shim.

### When Express is somebody else's dependency

A framework built on Express does not `require("express")` in your code, it requires it in its own,
so there is nothing for `migrate` to rewrite. Every package manager can answer `express` with this
package instead, for your project and everything under it, and this writes the block for whichever
one your project uses:

```sh
npx fulmine.js override             # read the lockfile, write the block, say what to run next
npx fulmine.js override --dry-run   # say what it would write, write nothing
```

It refuses rather than overwrites where a substitution is already there and is not this package. By
hand it is one of these:

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

Three things about µWebSockets.js make a Dockerfile that works for Express fail here, and all three have easy answers:

- **No Alpine, and no Debian bookworm either.** µWebSockets.js ships prebuilt binaries linked against glibc 2.38 or newer. Alpine images use musl, so the binary does not load at all; `node:26` and `node:26-slim` are Debian bookworm, whose glibc 2.36 fails at startup with `GLIBC_2.38' not found`. Use the trixie variants: `node:26-trixie-slim` and up.
- **`git` must be there when `npm install` runs.** µWebSockets.js is not on npm; it is installed straight from GitHub (`github:uNetworking/uWebSockets.js`), and npm uses git to fetch it. Full images like `node:26-trixie` have git; `-slim` ones do not.
- **git must be allowed to speak https.** Where the build environment rewrites GitHub URLs to ssh, which some CI images and company-wide git configs do, the fetch asks for a key the image does not have and the install dies on a permission denied that never names µWebSockets.js. One line before `npm ci` puts it back:

    ```dockerfile
    RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
    ```

The clean way to satisfy the first two is a multi-stage build: install with the full image, run with the slim one.

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

- `app.listen()` returns the app rather than a separate server object, and the app answers as an `http.Server`: `app instanceof http.Server` is true, which is what the graceful shutdown wrappers and the connection trackers look for. There is still no node server underneath, the socket belongs to µWS, so what is answered is the surface and not the plumbing. There: `close()`, `address()`, `listening`, `getConnections()`, `ref()`, `unref()`, `setTimeout()` and the `keepAliveTimeout` family. Not there: nothing emits `connection`, `request` or `upgrade`, `getConnections()` counts the requests in flight rather than sockets, and the timeouts belong to µWS and are set through `uwsOptions.idleTimeout`. Anything that wants to serve its own protocol on the socket, socket.io being the usual case, still wants `app.uwsApp`. Runnable: [`examples/graceful-shutdown.js`](./examples/graceful-shutdown.js).
- `x-powered-by` is disabled by default. Express sends `X-Powered-By: Express` unless you turn it off; Fulmine does not send it unless you turn it on with `app.set("x-powered-by", true)`. The header only tells anyone asking which framework is running.
- request body is only read for POST, PUT, PATCH and QUERY requests by default. You can add additional methods by setting `body methods` to array with uppercased methods.
- **A request whose framing cannot be trusted is refused by hanging up, with no answer at all.** Node's parser refuses each of these with a `400` and Fulmine refuses the same ones: a repeated `Content-Length`; one that is not a plain count of bytes, an empty value or a count past `Number.MAX_SAFE_INTEGER` included; a `Transfer-Encoding` whose last coding is not `chunked`; and a method nobody defines, which includes a lowercase one, since methods are case sensitive. µWS accepts all of them. It frames the request on the first length, or on no body at all, and it takes any token as a method, so `{"a":1}GET /path HTTP/1.1` is a request line to it. What the client sent as a body is then read as the next request on the connection: that is request smuggling, and a proxy in front disagreeing about the framing is all it takes. The answer differs from Express because it cannot be helped. µWS only skips the request it has already queued when the response is closed rather than completed, and writing the `400` completes it, so the choice is between telling the client and stopping the smuggled request. Nothing well behaved sends any of these.
- **A compiled route answers `connection: keep-alive` to a client that sent `Connection: close`.** A handler simple enough to be read at registration time is answered by µWS from a response written once at `listen()`, and that response cannot read the request. The socket still closes, so what is wrong is the header and not the transport. A response that would carry a validator is never compiled, so conditional requests behave as on Express; `app.set("declarative responses", false)` turns compiling off.
- **Informational responses go nowhere.** `res.writeEarlyHints()`, `res.writeContinue()` and `res.writeProcessing()` are all there, take what node's take and throw what node's throw once the head has gone out, but nothing reaches the wire: µWebSockets.js has no API for a `1xx`. They exist so that code written for Express keeps running rather than dying on "is not a function", which is the only thing a drop-in can honestly promise here. `res.addTrailers()` is the same story, and `res.setTimeout()` and `req.setTimeout()` register the listener without changing anything, since µWS runs its own idle timeout through `uwsOptions.idleTimeout`.
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

Runnable: [`examples/https.js`](./examples/https.js).

- This also applies to non-SSL HTTP too. Use `app.listen()` rather than creating a server by hand. `http.createServer(app)` does work, because the app is a request listener like Express's and answers node's requests through a shim, which is what lets `supertest`, `vhost` and anything else that calls an app keep working. But it serves those requests through `node:http` rather than through µWS, so the speed is Express's. It is there for compatibility, not for production.
- **Node 22, 24 and 26, not every version above 22.** µWebSockets.js ships one prebuilt binary per Node ABI and skips the odd lines, so Node 23 and 25 have no binary to load and fail at `require`. `npx fulmine.js verify` says which binary this machine wants and whether it is there. The odd/even model ends with Node 26, so the gap closes on its own.
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

On top of that, a handler simple enough to be read at registration time is compiled into a uWS declarative response and answered natively, without entering JavaScript at all. That needs the route to have nothing in front of it, not a middleware and not a `Router` it was mounted under, and a single handler that only calls `res.status`, `res.set`, `res.type`, `res.append`, `res.send`, `res.json`, `res.sendStatus` or `res.end` with literal arguments, plus `req.query`. `res.set` takes a pair or a whole object of them, and `res.type` takes what it takes anywhere, since a media type is a lookup on a literal. Anything else, a variable, a call, an `if`, falls back to ordinary routing. `return res.send(...)` compiles, `res.send(...)` does too, and so does an object or an array of literals however deeply nested. Mounting a `Router` costs only this: the routes inside one are still registered on the native uWS router with their full path, and are as fast as any other optimized route.

Three things are refused whatever the handler does, and all three are the same fact: a response written at startup cannot read the request.

- one that would carry an `ETag` or a `Last-Modified`, since it could never answer with the `304 Not Modified` that the validator invites. `etag` is on by default, so `app.set("etag", false)` is what puts an ordinary route on this path.
- one whose route captures, `/users/:id`, since a value that cannot be decoded is a `400` in Express and nothing runs here to raise it.
- a `204`, `205` or `304`, since the body would go out with the status and a client frames those as bodiless whatever it reads.

Two things then follow from the response being static:

- it carries a `Content-Length` while its body is literal all the way through. A body with a piece taken from the request, `res.send(req.query.q)`, has no length until the request arrives, so that one is framed as `Transfer-Encoding: chunked`. uWS writes the framing either way, which is why neither header can be set by hand.
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

A path is written as it was registered, `"/users/:id"` and not `"/users/7"`, and a trailing `*` names everything under a prefix. A pattern that matches no route throws too, so a misspelled path fails instead of passing quietly. The application does not need to be listening. Runnable: [`examples/fast-routes.js`](./examples/fast-routes.js).

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

`route;desc="native"` means µWS matched the path in C++ and the chain was worked out at startup; `route;desc="router"` means this one was matched here, layer by layer. `res.timing(name, ms, desc)` and `res.time(name, fn)` add marks of your own, and `fn` may return a promise. The duration ends where the header does, since Server-Timing goes out with the head. A route compiled into a response never enters JavaScript, so nothing times it: `npx fulmine.js profile` is where those are counted. Runnable: [`examples/server-timing.js`](./examples/server-timing.js).

2. Do not use external `serve-static` module. Instead use built-in `express.static()` middleware, which is optimized for Fulmine. If your build already writes `.br` and `.gz` files next to the originals, `express.static(dir, { preCompressed: true })` serves those to the clients that accept them, so nothing is compressed at request time and a fraction of the bytes goes out: on a 4KB script with a brotli twin, 12 times fewer. It costs no more than serving the file itself, one `stat` per request, because the twin is looked for before the file and its own `stat` is the only one the request needs. A type that is already compressed, a woff2 or a webp, is not looked up at all, and which twins a path has is remembered for a second: `{ cache: false }` asks the disk every time, `{ cache: "5s" }` sets the window. Only their presence is remembered, never their size or mtime, so nothing is ever described by a stale number. `Vary: Accept-Encoding` is sent whether or not a twin is found, the content type stays the one the requested name implies, and each variant carries its own ETag. Runnable: [`examples/static-precompressed.js`](./examples/static-precompressed.js).

3. Do not use `body-parser` module. Instead use built-in `express.text()`, `express.json()` etc.

4. Do not use the `compression` module. `express.compression()` takes the same options and decides the same way, and it served about 50% more requests per second on an 8KB JSON body here, gzip and brotli alike. A response that arrives whole, which is every `res.send()` and `res.json()`, is compressed in one call rather than through a transform stream and goes out with a `Content-Length` instead of chunked; a response written in pieces still streams. The bytes are the same bytes either way.

```js
// the compression module's options, unchanged: threshold, filter, level, brotli, enforceEncoding
app.use(express.compression({ threshold: 1024 }));
```

Runnable: [`examples/compression.js`](./examples/compression.js).

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

Anything held per process is now held per worker: an in-memory cache, a rate-limit counter, a session store or a `Map` of connected sockets is not shared, and needs Redis or something like it to be. `app.close()` in the primary stops the workers, and a `SIGTERM` or `SIGINT` that reaches only the primary, which is what a container sends, is passed on to them. Runnable: [`examples/cluster.js`](./examples/cluster.js).

## WebSockets

`app.ws()` registers a WebSocket route, served by µWS itself. The upgrade never reaches node, so `server.on("upgrade")` and the libraries built on it have nothing to hear; this is the replacement.

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
- **Routers work.** `router.ws("/lobby", ...)` mounted with `app.use("/chat", router)` serves `/chat/lobby`.
- **Paths are the ones µWS matches**: literal, or with parameters that are a whole segment such as `/room/:id`. Anything else throws where it is written rather than failing to match later.
- **Broadcasting from outside a socket**: `app.publish(topic, message)` and `app.numSubscribers(topic)`.

A WebSocket route and an ordinary route can share a path: the upgrade goes to the WebSocket route, a plain GET goes through normal routing. Runnable, with a page that opens the socket: [`examples/websocket.js`](./examples/websocket.js).

If you would rather use the `ws` module's API, [Ultimate WS](https://github.com/dimdenGD/ultimate-ws) is a drop-in replacement for it written against Ultimate Express, and Fulmine still exposes the mechanism it hooks into, but that combination is not covered by this project's tests. `app.uwsApp` also remains available for anything µWS offers that this does not.

### socket.io

socket.io normally takes over the upgrade on a node `http.Server`. The upgrade here never reaches
node, so hand it the µWS app instead, which socket.io supports natively through `attachApp()`:

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

`attachApp()` works before or after `app.listen()`. What does not work is `new Server(app)` on the
app itself, or on what `app.listen()` returns, which is the same object: socket.io refuses it with
"You are trying to attach socket.io to an express request handler function", because it checks for a
function before it checks for a server, and an app here is callable. That refusal is the useful
answer. Even if it accepted the object, there is no node socket behind it to take an upgrade over,
so it would have failed later and more quietly. Plain HTTP keeps serving either way. This is covered
by `tests/tests/middlewares/socket-io.js`, which runs the same file against Express and against
Fulmine and compares the output. Runnable: [`examples/socket-io.js`](./examples/socket-io.js).

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
meant. It is the binary v2 preamble that µWS reads, not the v1 text line, so a connection starting
with `PROXY TCP4 ...` is answered as a malformed request. Runnable, with a client that writes one:
[`examples/proxy-protocol.js`](./examples/proxy-protocol.js).

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
-   - ✅ options.index, options.redirect, options.fallthrough, options.extensions
-   - ✅ options.dotfiles, plus `"ignore_files"`, which is Fulmine's own: it hides a dotfile that is the last segment while letting a dotted directory through
-   - ✅ options.setHeaders, options.headers
-   - ✅ options.etag, options.lastModified, options.maxAge, options.immutable, options.cacheControl, options.acceptRanges
-   - ✅ options.preCompressed, Fulmine's own: serve the `.br` or `.gz` twin on disk, described under [Performance tips](#performance-tips)
- ✅ express.text()
- ✅ express.raw()
- ✅ express.serverTiming(). Fulmine's own: Server-Timing carrying how the request was routed, described under [Performance tips](#performance-tips).
- ✅ express.testing. Fulmine's own: `expectNative`, `expectDeclarative` and `routeReport`, described under [Performance tips](#performance-tips).
- ✅ express.compression(). Fulmine's own, since Express has none: it is the [compression](https://npmjs.com/package/compression) module's options and behaviour built in, described under [Performance tips](#performance-tips).
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

What `listen()` hands back is the app, and it answers as an `http.Server` so the shutdown wrappers
recognise it: `app.close()`, `app.address()`, `app.listening`, `app.getConnections()`, `app.ref()`,
`app.unref()`, `app.setTimeout()` and the `keepAliveTimeout` family. See
[Differences from Express](#differences-from-express) for what is behind them and what is not.

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

Fulmine adds eight of its own:

- `body methods`, unset by default. The body is read for POST, PUT, PATCH and QUERY, and this names the methods to read one for as well: `app.set("body methods", ["DELETE"])`. Reading a body no handler asks for costs about 15%, which is why the built-in list is short rather than every method.
- `native routes`, on by default. Off, every request walks the ordinary chain instead of letting µWS match what it can, which is slower and answers the same. It is a diagnostic rather than a tuning knob: it exists so one application can be served both ways and the two sets of answers compared, which is how the optimizer is tested. A compiled response needs a native registration to hang on, so turning this off turns `declarative responses` off with it.
- `etag methods`, unset by default. Express computes the generated ETag for every method, and so does this until told otherwise. `app.set("etag methods", ["GET", "HEAD"])` skips the digest on every other method, where freshness is not defined and the validator can never match: worth 21% here on a 4KB POST answer. An ETag set by hand still goes out whatever the method.
- `declarative responses`, on by default. Lets a simple enough handler be compiled into a native uWS response, described under [Performance tips](#performance-tips).
- `connection headers`, on by default. Express sends `Connection: keep-alive` and `Keep-Alive` on every response, and so does this. Turn it off and neither goes out, while a connection the client asked to close still answers `Connection: close`: it is the advertisement that goes, not the truth. Worth 2% to 3.5% here on a route that is not compiled, plus the bytes.
- `file cache`, on by default. Small files served by `res.sendFile` come from a bounded in-process cache, checked against the file's `stat` on every request, so an edited file is never served stale. Turn it off where every request has to reach the disk, which is what a public benchmark asks of a standard entry: it was worth about 4% on a 4KB file here, so the cost of turning it off is small.
- `stat cache`, off by default. Takes a duration, `app.set("stat cache", "1s")`. The size and mtime of a file served by `res.sendFile` or `express.static` are remembered for that long, so a file that is asked for again inside the window costs no syscall at all. It was worth 15% on a 3KB file and 3% on a 200KB one, where the bytes are the work. What it costs is the one promise the `file cache` keeps: inside the window an edited file is served as it was, so keep the window shorter than you would notice.
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
- ✅ [compression](https://npmjs.com/package/compression) (use `express.compression()` instead for better performance)
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

## Examples

[`examples/`](./examples/README.md) has one runnable file per thing this does that Express does not:
the cluster option, `app.ws()`, socket.io through `attachApp`, the pre-compressed twins,
`express.compression()`, `express.serverTiming()`, TLS through `uwsOptions`, the PROXY protocol,
what `listen()` decided about each route, and the app answering as an `http.Server`. What an
Express application already does is documented by Express and is not repeated there.

```sh
cd examples
npm install
node websocket.js
```

## Working on Fulmine

How to run the suites, what each of them is for, and how to write a comparison test:
[`CONTRIBUTING.md`](./CONTRIBUTING.md). What is expected of everyone taking part:
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

Found something exploitable? Report it privately rather than in an issue, and see
[`SECURITY.md`](./SECURITY.md) for what is in scope and what to expect.
