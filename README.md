<img src="./assets/logo-mark.svg" alt="" width="88" align="right">

# Fulmine.js: the drop-in Express 5 replacement, up to 20x faster

**Fulmine** (lightning in Italian ⚡) is an Express 5 compatible web framework for Node.js, built on
[µWebSockets.js](https://github.com/uNetworking/uWebSockets.js) instead of `node:http`. Same API, same
middleware, same tests. Change one line and your Express application runs faster.

**Docs: [fulmine.sndesign.it](https://fulmine.sndesign.it)**

```js
const express = require("fulmine.js"); // instead of require("express")
```

[![npm version](https://img.shields.io/npm/v/fulmine.js)](https://www.npmjs.com/package/fulmine.js)
[![npm downloads](https://img.shields.io/npm/dm/fulmine.js)](https://www.npmjs.com/package/fulmine.js)
[![Node.js 22 | 24 | 26](https://img.shields.io/badge/Node.js-22%20%7C%2024%20%7C%2026-green)](https://nodejs.org)
[![HTTP Arena](https://img.shields.io/endpoint?url=https://www.http-arena.com/badge/fulmine.js/h1.json)](https://www.http-arena.com/#tuned=0)
[![Coverage Status](https://coveralls.io/repos/github/nigrosimone/fulmine.js/badge.svg?branch=main)](https://coveralls.io/github/nigrosimone/fulmine.js?branch=main)
[![CodeQL](https://github.com/nigrosimone/fulmine.js/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/nigrosimone/fulmine.js/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/nigrosimone/fulmine.js/badge)](https://scorecard.dev/viewer/?uri=github.com/nigrosimone/fulmine.js)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14089/badge)](https://www.bestpractices.dev/projects/14089)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

## Why Fulmine

- **Faster than Express, measured.** 1.3x to 4.9x on plain routing, 2x to 5x on a request with a body,
  7x to 20x on a large route table, on every CI run. Routes are matched in C++ by µWS's own router,
  and a simple enough handler is answered without running any JavaScript at all.
- **Zero rewrite.** `helmet`, `cors`, `passport`, `morgan`, `multer`, `express-session` and the rest of
  the Express ecosystem keep working. Not "mostly": every test runs against real Express first and the
  output must match byte for byte, and Express 5's own test suite passes whole, 1130 of 1130.
- **Your framework works too.** NestJS, Next.js, Astro, SvelteKit, React Router, Angular SSR, Apollo
  Server, tRPC, tsoa, MCP servers: each one is served twice in CI, on Express and on Fulmine, and compared.
- **Ranked in public.** See [HttpArena](https://www.http-arena.com/#sort=rps:-1&q=Js) and
  [web-frameworks](https://web-frameworks-benchmark.netlify.app/result?l=javascript), run on their
  hardware with their rules. No figure is copied here, the boards are the current ones.
- **More than Express, when you want it.** Multi-core cluster on one port, native WebSockets, built-in
  compression and pre-compressed static files, Server-Timing, PROXY protocol, TLS. All optional.
- **Typed, TypeScript first.** ESM, CommonJS, named imports and the Express types you already use.

## Quick start

```sh
npx fulmine.js create my-app   # a server, a package.json and a Dockerfile that works, --ts for TypeScript
cd my-app && npm install && npm run dev
```

Or in a project you already have:

```sh
npm install fulmine.js
```

```js
const express = require("fulmine.js");
const app = express();

app.use(express.json());
app.get("/users/:id", (req, res) => res.json({ id: req.params.id }));

app.listen(3000);
```

ESM and TypeScript work the same way, named imports included:

```ts
import express, { Router, json } from "fulmine.js";
import type { Request, Response } from "fulmine.js";
```

Requirements: Node 22, 24 or 26, on Linux, macOS or Windows, x64 or arm64. Not Alpine (glibc 2.38+
is needed) and not Bun; pnpm refuses the install (`ERR_PNPM_EXOTIC_SUBDEP` on uWebSockets.js) until
[one command](./docs/deployment.md#pnpm) is run. `npx fulmine.js verify` tells
you in thirty seconds whether this machine, your package manager and your Docker image can run it,
and [Deploying](./docs/deployment.md) has the Dockerfile that works.

## Migrate an existing Express app

One command rewrites the imports across a whole project, and then tells you the handful of things
that behave differently:

```sh
npx fulmine.js verify              # can this machine and this image even run it
npx fulmine.js migrate --dry-run   # say what it would change, change nothing
npx fulmine.js migrate             # do it
npx fulmine.js override            # when a framework requires express in its own code, not in yours
npx fulmine.js angular             # angular.json's server build, one line of config
npx fulmine.js pnpm                # the two lines a pnpm project needs before it installs this
npx fulmine.js differences         # just the list of what to check by hand
```

NestJS is one import, `FulmineExpressAdapter` from `fulmine.js/nest`. Angular SSR's `server.ts` is
an ordinary Express application and takes the one-line change. A framework that requires Express in
its own code, not in yours, is answered with a package manager override, and `override` writes it.
The whole guide: [Migrating](./docs/migrating.md).

## Where the speed comes from

Express finds a route by walking its stack and testing each layer against the path, on every request.
Fulmine hands every route it can to µWS's router, which matches in C++, and works out at `listen()`
which middlewares stand in front of each one. Arriving at a handler costs no matching at all, and the
gap grows with the route table instead of shrinking.

On top of that, most of what makes a request expensive is work that simply does not happen: the body
is not read unless a handler asks, the headers are not copied out of µWS unless something reads them,
the request is not turned into a stream unless something streams it. A handler simple enough to be
read at registration time is compiled into a static response and answered by µWS itself.

`npx fulmine.js profile` prints what `listen()` decided about each of your routes, and
`npx fulmine.js explain /api/items` tells the story of one request. Ten measured tips, from
`express.compression()` to `cluster: "auto"`, are in [Performance](./docs/performance.md).

## Beyond Express

Everything Express does, plus these. Each one is a runnable file in [`examples/`](./examples/README.md).

| Feature                                                               | One line                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| One process per core, one port, no primary in the path                | `express({ cluster: "auto" })`                               |
| Native WebSockets, with an `upgrade(req, res)` hook for auth          | `app.ws("/room/:id", { open, message, close })`              |
| socket.io                                                             | `io.attachApp(app.uwsApp)`                                   |
| Compression built in, 50% more requests per second than `compression` | `app.use(express.compression())`                             |
| Serve the `.br` and `.gz` twins your build already wrote              | `express.static(dir, { preCompressed: true })`               |
| Server-Timing with how the request was routed                         | `app.use(express.serverTiming())`                            |
| Assert in a test that a route stays on the fast path                  | `express.testing.expectNative(app, ["/api/*"])`              |
| HTTPS without `https.createServer`                                    | `express({ uwsOptions: { key_file_name, cert_file_name } })` |
| PROXY protocol from HAProxy, AWS NLB, nginx, Envoy                    | `app.set("trust proxy protocol", true)`                      |

Details in [WebSockets](./docs/websockets.md), [Performance](./docs/performance.md) and
[Deploying](./docs/deployment.md).

## Compatibility

Use the [Express 5 documentation](https://expressjs.com/en/5x/api.html) as the reference: the
application, request, response and router APIs are all there, settings included. The full checklist,
the tested middlewares, frameworks and view engines, and the eight settings Fulmine adds, are in
[Compatibility](./docs/compatibility.md).

A few things answer differently because there is no `node:http` underneath: `app.listen()` returns
the app, which also answers as an `http.Server`; TLS is configured through `express()`; the body is
read for POST, PUT, PATCH and QUERY unless told otherwise; `x-powered-by` is off. The complete list,
with the reason for each: [Differences from Express](./docs/differences.md).

## Compared with similar projects

- **`ultimate-express`** is what Fulmine is derived from, and is the closest relative by far. It targets Express 4, keeps the v4 API surface and its deprecations. Fulmine targets Express 5 only, which removes the compatibility layer for everything v5 dropped, and is typed. If you are on Express 4, use `ultimate-express`.
- **`hyper-express`** has a similar API but is not a drop-in replacement. It implements much of the functionality differently, which produces quirks that make switching an existing application difficult, and most Express middleware is unsupported.
- **`uwebsockets-express`** is closer to a drop-in replacement, but misses a lot of the API, depends on Express by calling its methods under the hood, and does not use the native µWS router.
- **`express` on Bun** benefits from Bun using µWS for its HTTP module, but performs no µWS-specific optimizations.

## Documentation

- [Why Fulmine](./docs/why.md): what it is, what it costs, who is behind it
- [Migrating](./docs/migrating.md): the CLI, Angular SSR, NestJS, and when Express is somebody else's dependency
- [Deploying](./docs/deployment.md): Docker, pnpm, a private npm registry, behind a proxy
- [Performance](./docs/performance.md): the numbers, the tips, `profile`, `explain` and the testing helpers
- [Differences from Express](./docs/differences.md): what answers differently and why
- [WebSockets](./docs/websockets.md): `app.ws()` and socket.io
- [Compatibility](./docs/compatibility.md): the API checklist, tested middlewares, frameworks and view engines
- [Compared with the others](./docs/compare.md): ultimate-express, hyper-express, Fastify, Bun, raw µWS
- [Examples](./examples/README.md): one runnable file per feature
- [Contributing](./CONTRIBUTING.md), [Security](./SECURITY.md), [Changelog](./CHANGELOG.md)

## Versioning

**The major number tracks Express, not semver.** Fulmine 5.x follows Express 5. If Express 6
arrives, Fulmine goes to 6, and that is the only reason the major ever moves. Minor is for new
behaviour, patch for fixes, so a breaking change can land in a minor: it is in the changelog under
its own heading, but the version number alone will not warn you. If you pin, pin the minor.

## Attribution

Fulmine is a derivative work of [Ultimate Express](https://github.com/dimdenGD/ultimate-express) by [@dimdenGD](https://github.com/dimdenGD), used under the Apache License 2.0. The full commit history is preserved, so the original authorship is visible in the repository itself.

**Special thanks to [@dimdenGD](https://github.com/dimdenGD).** Ultimate Express is the hard part of this project, and it was already done before Fulmine existed. Everything here stands on that work.

Fulmine is not affiliated with, endorsed by, or maintained by the authors of Ultimate Express. See [`NOTICE`](./NOTICE) for the list of significant changes.

It is likewise not affiliated with the OpenJS Foundation or the Express.js project. Express is a trademark of the OpenJS Foundation.

## License

[Apache-2.0](./LICENSE). Found something exploitable? Report it privately, see
[`SECURITY.md`](./SECURITY.md).
