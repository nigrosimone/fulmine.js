---
description: Compare Fulmine.js with Express alternatives, Fastify, Hono and Elysia, including API compatibility, middleware support and migration trade-offs.
---

# Compared with the others

The question behind every comparison here is the same one: **can you drop it into an existing Express application?** Speed without that is a rewrite, and a rewrite has its own candidates.

## Express alternatives on uWebSockets.js

|                     | Express API                   | Express 5 | Middleware ecosystem | Native µWS router            | Typed |
| ------------------- | ----------------------------- | --------- | -------------------- | ---------------------------- | ----- |
| **Fulmine.js**      | drop-in, tested byte for byte | yes, only | works, tested        | yes, plus compiled responses | yes   |
| ultimate-express    | drop-in                       | Express 4 | works                | yes                          | no    |
| hyper-express       | similar, not drop-in          | no        | mostly unsupported   | yes                          | yes   |
| uwebsockets-express | partial                       | no        | partial              | no                           | yes   |

- **[ultimate-express](https://github.com/dimdenGD/ultimate-express)** is what Fulmine is derived from, and the closest relative by far. It targets Express 4, keeps the v4 API surface and its deprecations. Fulmine targets Express 5 only, which removes the compatibility layer for everything v5 dropped, is typed, and adds compiled responses, the cluster option, the testing helpers and the CLI. If you are on Express 4 and staying there, use ultimate-express.
- **[hyper-express](https://github.com/kartikk221/hyper-express)** has a similar API but is not a drop-in replacement. It implements much of the functionality differently, which produces quirks that make switching an existing application difficult, and most Express middleware is unsupported.
- **[uwebsockets-express](https://github.com/colyseus/uWebSockets-express)** is closer to a drop-in, but misses a lot of the API, depends on Express by calling its methods under the hood, and does not use the native µWS router.

## Fastify, Hono, Elysia

These are not Express replacements, they are different frameworks with their own API, plugin model and middleware. Choosing one means rewriting routes, plugins and tests, and their ecosystems are theirs, not Express's.

That can be the right call for a new project. For an existing Express application the arithmetic is different: the rewrite costs weeks and Fulmine costs one line, and where the framework is the bottleneck the line buys the same order of gain. Where the bottleneck is elsewhere, a database, `JSON.parse`, zlib, no framework moves it, and [the performance page](./performance.md) says which rows those are.

Numbers between frameworks are only worth reading from a rig that runs all of them the same way: [HttpArena](https://www.http-arena.com/#sort=rps:-1&q=Js) and [web-frameworks](https://web-frameworks-benchmark.netlify.app/result?l=javascript) both do, and both list Fulmine beside Fastify, Hono and Elysia. [Sharkbench](https://sharkbench.dev/web/javascript) lists it beside Express and Fastify on Node.js and Bun. No figure is copied here, the boards are the current ones.

## Express on Bun

Bun uses µWebSockets for its HTTP module, so Express on Bun is faster than Express on Node without any µWS-specific optimization: routes are still scanned layer by layer in JavaScript. µWebSockets.js is a native Node addon that Bun and Deno do not load, so there `app.listen()` serves through their `node:http`, as Express does, and WebSockets, TLS through `uwsOptions` and `app.uwsApp` need Node.

| Runtime    | Express | Fulmine through `node:http` | Fulmine through µWS |
| ---------- | ------: | --------------------------: | ------------------: |
| Node 26.7  |    8.5k |               12.6k (1.48x) |        39.0k (4.6x) |
| Bun 1.4.2  |   18.1k |               23.4k (1.29x) |                 n/a |
| Deno 2.9.7 |   11.5k |               17.1k (1.49x) |                 n/a |

Requests per second on the hello world of fastify/benchmarks (`{ hello: "world" }` as JSON), wrk with 100 connections and no pipelining, the server on one core of an Ampere A1 (arm64), median of five rounds, 2026-10-08. Fulmine on Node through µWS is about 2.2x Express on Bun.

## Raw uWebSockets.js

µWS on its own is faster than anything built on it, Fulmine included, and that is the declared price of having a router, middleware, a real request and a real response. What Fulmine keeps of that speed is the part that matters for an application: the native match, the compiled response for a static handler, and not doing the work a request did not ask for. On HttpArena's pipelined profile the compiled path is ahead of the other Express-shaped servers by a wide margin, and behind raw µWS by a small one.

## The short version

- On Express 5, wanting it faster without a rewrite: **Fulmine**.
- On Express 4 and staying there: **ultimate-express**.
- Starting from nothing with no Express code to keep: the comparison is between Fastify, Hono, Elysia and Fulmine, and the ecosystem you want decides it more than the benchmark does.
