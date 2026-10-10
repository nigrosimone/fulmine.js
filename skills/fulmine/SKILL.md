---
name: fulmine
description: Use when an Express 5 app should run on Fulmine.js (fulmine.js on npm), the drop-in Express replacement on uWebSockets.js, or when a project already uses it. Covers migration, the install traps (Docker, pnpm, Alpine, Node versions), the behaviour that differs from Express, and keeping routes on the fast path.
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

- A framework that requires Express in its own code: `npx fulmine.js override` writes the
  npm/pnpm/yarn override (`"express": "npm:fulmine.js@^5"`), then reinstall from clean.
- NestJS: `new FulmineExpressAdapter()` from `fulmine.js/nest` in `NestFactory.create`.
- Angular SSR: `server.ts` takes the one-line change, then `npx fulmine.js angular` marks
  `fulmine.js` and `uWebSockets.js` external in `angular.json`.
- `compression`, `body-parser` and `serve-static` have faster built-ins: `express.compression()`,
  `express.json()`, `express.static()`. Swap them by hand.

Run the project tests after migrating. Do not edit anything under `express/lib/...` paths, those
files are not Express here.

## Install traps

µWS is a native binary installed from GitHub, not from npm. Most failures come from this.

- **Node 22, 24 or 26 only.** Node 23 and 25 have no binary and fail at `require`.
- **glibc 2.38 or newer.** No Alpine (musl), no Debian bookworm. Use `node:26-trixie` /
  `node:26-trixie-slim`.
- **git must be in the image when `npm install` runs**: `-slim` images need
  `apt-get install -y git ca-certificates`, or use a multi-stage build (install on `node:26-trixie`,
  run on `node:26-trixie-slim`).
- If git rewrites GitHub to ssh in CI, the install fails with a permission error that does not name
  µWS. Fix: `git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"`.
- **pnpm 10.26+** refuses it with `ERR_PNPM_EXOTIC_SUBDEP`. Run `npx fulmine.js pnpm`, then
  `pnpm install`.
- npm with `allow-git=none` or `allow-git=root` refuses it with `EALLOWGIT`. Allow git, or host
  µWS in the private registry (see the Deploying page).
- Bun and Deno run it through their own `node:http`: plain HTTP works, but no WebSockets, no TLS
  through `uwsOptions`, no `app.uwsApp`, and no µWS speed.

## What differs from Express

- Start with `app.listen()`. `http.createServer(app)` works but goes through `node:http` and loses
  most of the speed. `app.listen()` returns the app, which answers as an `http.Server`.
- HTTPS: pass `uwsOptions: { key_file_name, cert_file_name }` to `express()`, not
  `https.createServer`.
- socket.io: `io.attachApp(app.uwsApp)`, not `io.attach(server)`.
- Header names go out lowercase. Tests that compare the raw response head text break, header
  values do not.
- Body is read only for POST, PUT, PATCH and QUERY. Other methods: `app.set("body methods", [...])`.
- Max header size is 4 KB, not 16 KB: set env `UWS_HTTP_MAX_HEADERS_SIZE` if needed.
- Idle keep-alive timeout is a fixed 10 s, `server.setTimeout()` and `keepAliveTimeout` change
  nothing. Bodies slower than 16 KB/s are dropped.
- `x-powered-by` is off by default.
- `res.writeEarlyHints()`, `writeContinue()` and trailers exist but send nothing.

Full list: https://fulmine.sndesign.it/differences

## Keep it fast

- `npx fulmine.js profile` shows what `listen()` decided for each route, and
  `npx fulmine.js explain /path` shows one request. Use them before guessing.
- Things that keep a route fast: not reading `req.headers` or the body when not needed, and simple
  handlers that `listen()` can compile into a static response.
- One process per core: `express({ cluster: "auto" })`. Per-process state (in-memory caches,
  rate-limit counters, socket maps) is not shared between workers.
- In tests, `express.testing.expectNative(app, ["/api/*"])` fails when a route leaves the fast path.

## Beyond Express

- Native WebSockets: `app.ws("/room/:id", { open, message, close })`, with `upgrade(req, res)` for
  auth.
- Pre-compressed assets: `express.static(dir, { preCompressed: true })` serves `.br` / `.gz` twins.
- `app.use(express.serverTiming())` adds Server-Timing with how the request was routed.
- `app.set("trust proxy protocol", true)` for PROXY protocol behind HAProxy, NLB, nginx, Envoy.
