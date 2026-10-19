---
description: Migrate an Express app to Fulmine.js, verify your environment and update imports, with guidance for NestJS, Angular SSR, hyper-express and framework integrations.
---

# Migrating to Fulmine.js

In a lot of cases, replacing `require("express")` with `require("fulmine.js")` is the whole migration. `npx fulmine.js migrate` does that across a project:

```sh
npx fulmine.js migrate [dir]       # defaults to the current directory
npx fulmine.js migrate --dry-run   # say what it would rewrite and rewrite nothing
npx fulmine.js differences         # print the list of differences and change nothing
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

## Angular SSR

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

## NestJS

`@nestjs/platform-express` takes an Express instance, so it takes this one, and the adapter is in the
package:

```ts
import { NestFactory } from "@nestjs/core";
import { FulmineExpressAdapter } from "fulmine.js/nest";

const app = await NestFactory.create(AppModule, new FulmineExpressAdapter());
await app.listen(3000);
```

TLS, WebSocket gateways, what changes and the numbers against the Express and Fastify adapters are
on their own page: [NestJS](./nest.md).

## From hyper-express

hyper-express runs on µWebSockets.js too, but its API is its own, so the move is renaming calls, not
rewriting the application. In return the Express middlewares work as they are.

| hyper-express                                        | Fulmine.js                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `new HyperExpress.Server()`, `new Router()`          | `express()`, `express.Router()`                                             |
| `server.listen(port).then(fn)`                       | `app.listen(port, fn)`, it does not return a promise                        |
| `server.any(path, fn)`                               | `app.all(path, fn)`                                                         |
| `set_error_handler((req, res, err) => {})`           | `app.use((err, req, res, next) => {})` after the routes                     |
| `set_not_found_handler(fn)`                          | `app.use(fn)` after the routes                                              |
| `req.path_parameters`, `req.query_parameters`        | `req.params`, `req.query`                                                   |
| `await req.json()`, `req.text()`, `req.urlencoded()` | `express.json()`, `express.text()`, `express.urlencoded()`, then `req.body` |
| `req.multipart(fn)`                                  | a multipart middleware, such as multer                                      |
| `req.locals`                                         | `res.locals`                                                                |
| `res.setHeaders({ ... })`                            | `res.set({ ... })`                                                          |
| `res.html(body)`                                     | `res.type("html").send(body)`                                               |
| `res.file(path)`                                     | `res.sendFile(path)`                                                        |
| `res.stream(readable)`                               | `readable.pipe(res)`                                                        |
| `res.atomic(fn)`                                     | nothing, the writes of one response are corked already                      |
| `res.throw(err)`                                     | `next(err)`                                                                 |
| `server.ws(path, options, fn)`                       | `app.ws(path, behavior)`, see [WebSockets](./websockets.md)                 |
| `server.publish()`, `num_of_subscribers()`           | `app.publish()`, `app.numSubscribers()`                                     |
| `server.uws_instance`                                | `app.uwsApp`                                                                |

Four differences do not throw, so look for them before the tests do:

- **An async middleware that resolves without calling `next()`** goes on in hyper-express. In Express,
  and here, the request waits forever. Call `next()` at the end.
- **`res.cookie(name, value, 3600000)`**: the third argument is the expiry in hyper-express and the
  options in Express, so the expiry is lost. Write `{ maxAge: 3600000 }`.
- **`res.cookie()` without options** is `Secure` and `SameSite=None` in hyper-express, and neither in
  Express. Pass them if you relied on them.
- **`res.header(name, value)` twice** sends both values in hyper-express, the second replaces the first
  in Express. Use `res.append()` to keep both.

## When Express is somebody else's dependency

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

// pnpm 10, in package.json (pnpm 11 reads overrides only from pnpm-workspace.yaml)
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
[the differences](./differences.md): what a framework does with Express is usually more
than what an application does. And a package that reaches into `express/lib/...` rather than its
public surface will not find what it expects, since the files there are ours.

Bun and Deno work, but without µWS: µWebSockets.js is a native Node addon they do not load, so
`app.listen()` serves through their `node:http`. Plain HTTP answers as on Node; WebSockets, TLS through
`uwsOptions` and `app.uwsApp` need Node, and the speed is [1.3x to 1.5x Express's](./compare.md#express-on-bun).
