---
name: fulmine
description: Use when an Express 5 app should run on Fulmine.js (fulmine.js on npm), the drop-in Express replacement on uWebSockets.js, or when a project already uses it. Covers migration, the install traps (Docker, pnpm, Alpine, Node versions), the behaviour that differs from Express, the settings and patterns for the best performance, the testing helpers that keep routes fast, and the features beyond Express (cluster, WebSockets, compression, HTTPS).
---

# Fulmine.js

Fulmine.js is Express 5 on top of uWebSockets.js (µWS). Same API, same middlewares, so the Express 5
documentation is the reference. Docs: https://fulmine.sndesign.it

## Migrate an Express app

```sh
npx fulmine.js verify              # can this machine and this Dockerfile run it, do this first
npx fulmine.js migrate --dry-run   # show the import rewrites
npx fulmine.js migrate             # rewrite require("express") / import ... from "express"
npx fulmine.js differences         # what to check by hand
```

- New project: `npx fulmine.js create my-app` (`--ts` for TypeScript, `--pnpm` for pnpm), with a
  Dockerfile that works.
- A framework that requires Express in its own code: `npx fulmine.js override` writes the
  npm/pnpm/yarn override (`"express": "npm:fulmine.js@^5"`), then reinstall from clean.
- NestJS: `new FulmineExpressAdapter()` from `fulmine.js/nest` in `NestFactory.create`.
- Angular SSR: `server.ts` takes the one-line change, then `npx fulmine.js angular` marks
  `fulmine.js` and `uWebSockets.js` external in `angular.json`.
- ESM and TypeScript: `import express, { Router, json } from "fulmine.js"`,
  `import type { Request, Response } from "fulmine.js"`.

Run the project tests after migrating. Do not edit anything under `express/lib/...` paths, those
files are not Express here.

## Install traps

µWS is a native binary installed from GitHub, not from npm. Most failures come from this.

- **Node 22, 24 or 26 only.** Node 23 and 25 have no binary and fail at `require`.
- **glibc 2.38 or newer.** No Alpine (musl), no Debian bookworm. `node:26` and `node:26-slim` are
  trixie and work. `node:22` and `node:24` are still bookworm: use `node:22-trixie-slim` /
  `node:24-trixie-slim`.
- **git must be in the image when `npm install` runs**: `-slim` images need
  `apt-get install -y git ca-certificates`, or use a multi-stage build (install on `node:26`, run on
  `node:26-slim`).
- If git rewrites GitHub to ssh in CI, the install fails with a permission error that does not name
  µWS. Fix: `git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"`.
- **pnpm 10.26+** refuses it with `ERR_PNPM_EXOTIC_SUBDEP`. Run `npx fulmine.js pnpm`, then
  `pnpm install`.
- npm with `allow-git=none` or `allow-git=root` refuses it with `EALLOWGIT`. Allow git, or host
  µWS in the private registry (see the Deploying page).
- Bun and Deno run it through their own `node:http`: plain HTTP works, but no WebSockets, no TLS
  through `uwsOptions`, no `app.uwsApp`, and no µWS speed.

## What differs from Express

- Start with `app.listen()`. `http.createServer(app)` works (supertest uses it) but goes through
  `node:http` and loses most of the speed. `app.listen()` returns the app, which answers as an
  `http.Server`.
- HTTPS: pass `uwsOptions: { key_file_name, cert_file_name }` to `express()`, not
  `https.createServer`.
- `server.on("upgrade")` never fires: use `app.ws()`, or `io.attachApp(app.uwsApp)` for socket.io.
- Header names go out lowercase. Tests that compare the raw response head text break, header
  values do not.
- Body is read only for POST, PUT, PATCH and QUERY. Other methods: `app.set("body methods", [...])`.
- Max header size is 4 KB, not 16 KB: set env `UWS_HTTP_MAX_HEADERS_SIZE` if needed.
- Idle keep-alive timeout is a fixed 10 s, `server.setTimeout()` and `keepAliveTimeout` change
  nothing. Bodies slower than 16 KB/s are dropped.
- `x-powered-by` is off by default.
- `res.writeEarlyHints()`, `writeContinue()` and trailers exist but send nothing.
- OpenTelemetry's HTTP instrumentation patches `node:http`, so it sees nothing on `app.listen()`.
  Tracers that read `diagnostics_channel` (`http.server.*`, `express.router.request`) work, and
  must subscribe before `listen()`. Sentry: `Sentry.setupExpressErrorHandler(app)` as on Express.

Full list: https://fulmine.sndesign.it/differences

## Performance: the biggest wins first

1. **One process per core**: `express({ cluster: "auto" })`. Each worker binds the same port with
   `SO_REUSEPORT`, the primary is not in the request path, and the cgroup CPU quota is respected.
   The whole file runs in every worker, so per-process state (in-memory caches, rate-limit
   counters, session stores, socket maps) is not shared: move it to Redis or similar.
2. **Routes µWS can match in C++.** A route is native when its path is a plain string or has
   whole-segment params (`/users/:id`). Not native: `/flights/:from-:to`, `*splat`, `{}` groups, and
   a route shadowed by a later one in the same router (`/users/:id` then `/users/me`: write the
   literal first).
3. **Handlers compiled to a static response**, answered by µWS without running JavaScript. Needs no
   middleware or router in front, one handler that only calls `res.status/set/type/append/send/
json/sendStatus/end` with literal arguments, and `app.set("etag", false)` (a validator cannot be
   answered from a static response). Params or query copied into the body need
   `app.set("declarative request values", true)`; only use it for plain values like an id.
4. **Built-in middlewares instead of the npm ones**: `express.json()`, `express.text()`,
   `express.urlencoded()` instead of `body-parser`; `express.static()` instead of `serve-static`;
   `express.compression()` instead of `compression` (same options, about 50% more req/s).
   `compression({ encodings: ["gzip"] })` avoids brotli cost on CPU-bound servers.
5. **Pre-compressed assets**: if the build writes `.br`/`.gz` next to the files,
   `express.static(dir, { preCompressed: true })` serves them with no compression at request time.
6. **Do not read what you do not need.** Fulmine skips copying headers, parsing the query, reading
   the body and building streams when nothing asks for them. A middleware that reads
   `req.headers.host` on every request puts that work back. Prefer `req.get("host")` in handlers
   that need one header, and keep header-reading middleware off hot routes.
7. **Settings**, each measured, each a trade-off:
    - `app.set("etag", false)`: about 8% on small responses, and enables compiled responses. No
      304s, so only for APIs that are never revalidated.
    - `app.set("etag methods", ["GET", "HEAD"])`: skip the digest on POST and the others, about 21%
      on a 4 KB POST answer, no downside.
    - `app.set("connection headers", false)`: drops `Connection`/`Keep-Alive` headers, 2-3.5%.
      Keep them if a client or proxy relies on them.
    - `app.set("stat cache", "1s")`: `express.static` and `res.sendFile` skip the `stat` syscall
      inside the window, up to 15% on small files. Edited files are served stale inside the window.
    - `app.set("case sensitive routing", true)`: lets more overlapping routes stay native.
    - Do not set `body methods` for GET; reading a body costs about 15%.
    - `express({ threads: n })`: file-read thread pool, default 1. Measure 0 as well.
8. **Known JSON shapes**: `express-fast-json-stringify` and `res.fastJson()` replace
   `JSON.stringify` with a compiled serializer.

Bottlenecks outside the framework (database, `JSON.parse`, zlib, template rendering) do not move.
Measure before and after on the real routes.

## Check and keep the fast path

```sh
npx fulmine.js profile             # what listen() decided for every route, and what to change
npx fulmine.js explain /api/x/:id  # one endpoint: matching, what is copied, each layer's cost
```

Use `profile` before guessing; it names the reason a route fell back and the fix. In tests, so a
later commit cannot silently slow a hot route:

```js
const { expectNative, expectDeclarative, expectLazy, routeReport, workReport } = require("fulmine.js").testing;

expectNative(app, ["/api/*", "GET /health"]); // throws, naming the route and the reason
expectDeclarative(app, "/health"); // compiled to a static response, no JavaScript at all
routeReport(app); // the whole list, to assert on

app.post("/items", (req, res) => {
    expectLazy(req, res, { allow: ["body"] }); // throws naming any other work this request built
    res.json(req.body);
});
```

Paths are written as registered (`"/users/:id"`), a trailing `*` covers a prefix, and a pattern
that matches no route throws. The app does not need to be listening.

In production, `app.use(express.serverTiming())` writes `route;desc="native"` or `"router"` and the
extra work a request did into `Server-Timing`; `res.timing(name, ms)` and `res.time(name, fn)` add
your own marks.

## Beyond Express

- **WebSockets**: `app.ws("/room/:id", { upgrade(req, res), open, message, close })`, also on
  routers. `upgrade` gets the real request and response: answering `res` declines the socket,
  values set on `req` live on as `ws.req`. µWS options (`maxPayloadLength`, `idleTimeout`,
  `compression`) pass through. Broadcast with `ws.publish(topic, msg)` or `app.publish(topic, msg)`.
- **socket.io**: `io.attachApp(app.uwsApp)`, before or after `listen()`.
- **HTTPS**: `express({ uwsOptions: { key_file_name, cert_file_name } })`.
- **PROXY protocol** (HAProxy, AWS NLB, nginx, Envoy): `app.set("trust proxy protocol", true)`, only
  when nothing but the proxy can reach the server.
- **Graceful shutdown**: `app.close()`; in cluster mode the primary passes `SIGTERM`/`SIGINT` on.
- **Raw µWS** for anything else: `app.uwsApp`.

Runnable examples for each: https://github.com/nigrosimone/fulmine.js/tree/main/examples
