---
description: Learn why Fulmine.js combines the Express 5 API with native uWebSockets.js routing, how compatibility is tested, and which trade-offs to consider.
---

# Why Fulmine

There are several fast HTTP servers for Node built on [µWebSockets.js](https://github.com/uNetworking/uWebSockets.js). What is scarce is one you can drop into an existing Express application without rewriting it. That is the whole project: **an Express 5 that runs on µWebSockets.js**, and everything else follows from taking both halves of that sentence seriously.

## Compatibility is a test suite, not a claim

Every test in the repository runs against real Express first and then against Fulmine, and the two outputs have to match byte for byte: status, headers, body. That is what makes `helmet`, `cors`, `passport`, `morgan`, `multer`, `express-session` and the rest of the ecosystem work rather than "mostly work". Express 5's own test suite runs against Fulmine too and passes whole, 1130 passing, 0 failing, at the pinned Express version.

Frameworks are a larger user of the Express surface than any application, so they have [a suite of their own](./compatibility.md#tested-frameworks): NestJS, Next.js, Astro, SvelteKit, React Router, Apollo Server, tRPC, tsoa and an MCP server, each served twice and compared.

A change that answers differently from Express is a bug here, even when the new answer looks better. The few places where it cannot be helped are [written down with the reason](./differences.md).

## Where the speed comes from

Express finds a route by walking its stack and testing each layer against the path, on every request. Fulmine hands every route it can to µWS's own router, which matches in C++, and works out at `listen()` which middlewares stand in front of each one. Arriving at a handler costs no matching at all, and the gap grows with the route table instead of shrinking: a handful of routes measures 1.3x to 4.9x, a thousand measures 7x to 20x.

Most of the rest is work that does not happen. The body is not read unless a handler asks, the headers are not copied out of µWS unless something reads them, the request is not turned into a stream unless something streams it. A handler simple enough to be read at registration time is compiled into a static response and answered by µWS itself, without entering JavaScript.

Where the cost is a shared library, `JSON.parse` on a big body, zlib, OpenSSL, it is a wash, and [the performance page](./performance.md) says so rather than publishing those rows as wins.

## What you get on top

Express has no answer for these, so Fulmine adds them, all optional:

- `express({ cluster: "auto" })`: one process per core, every one bound to the same port with `SO_REUSEPORT`, no primary in the path.
- `app.ws(path, behavior)`: WebSockets served by µWS itself, with an `upgrade(req, res)` hook that sees the same request your routes see.
- `express.compression()`: the `compression` module's options and decisions, about 50% more requests per second.
- `express.static(dir, { preCompressed: true })`: the `.br` and `.gz` twins your build already wrote.
- `express.serverTiming()`: a `Server-Timing` header saying how the request was routed.
- `express.testing`: assert in a test that a route stays on the fast path, so a commit that slows one down fails CI instead of being found weeks later.
- TLS through `express({ uwsOptions })`, PROXY protocol through one setting.

## What it costs

Every one of these is a real price, so here they are:

- **A native binary.** Node 22, 24 or 26 on Linux, macOS or Windows, x64 or arm64, glibc 2.38 or newer. No Alpine, no Bun. `npx fulmine.js verify` checks a machine and a Dockerfile in thirty seconds, and [Deploying](./deployment.md) has the image that works.
- **µWebSockets.js is not on npm.** It is installed from GitHub, which needs git at install time and [one command under pnpm](./deployment.md#pnpm).
- **A few things answer differently**, because there is no `node:http` underneath: [Differences from Express](./differences.md).
- **The major tracks Express**, not semver. Fulmine 5 follows Express 5. If you pin, pin the minor.

## Who is behind it

One maintainer, and a lineage: the credits, the licences and the people this stands on are in
[Attribution](./attribution.md).
