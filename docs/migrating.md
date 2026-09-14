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
`http.Server`, so it is the server rather than being put inside one. The edges: `forceCloseConnections`
has nothing to destroy, since the sockets belong to µWS and nothing emits `connection`, so it now
says so instead of quietly doing nothing; and Nest decides whether it has already added its body
parsers by scanning `app.router.stack`, which is not there, so the adapter remembers instead of
letting a second call add a second pair. `httpsOptions` is refused rather than silently starting a
plaintext server: TLS is configured on the app, through `uwsOptions`.

Measured on the same Nest application, controllers, pipes and body parsing unchanged: **1.2x on a
route answering text and 1.9x on one answering JSON with a route parameter**. `app.close()` closes
the port, as it does on the shim.

A Nest application answering the same bytes on both is [a case in the integration
suite](../integrations/cases/nest.js), so this is tested rather than claimed.

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
[the differences](./differences.md): what a framework does with Express is usually more
than what an application does. And a package that reaches into `express/lib/...` rather than its
public surface will not find what it expects, since the files there are ours.

Bun is not an option: µWebSockets.js is a native Node addon, and Bun does not load it.
