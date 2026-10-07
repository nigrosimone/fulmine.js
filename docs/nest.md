---
description: Run a NestJS application on uWebSockets.js with FulmineExpressAdapter. Same @nestjs/platform-express, controllers and Express middleware, about 4.8x platform-express and 2x platform-fastify on the same app.
---

# NestJS

Nest talks to HTTP through an adapter, and its Express one, `@nestjs/platform-express`, takes any
Express instance. Fulmine is one, so a Nest application runs on uWebSockets.js with one change in
`main.ts`. Controllers, pipes, guards, interceptors, exception filters and Express middleware stay
as they are.

```sh
npm install fulmine.js
```

`@nestjs/platform-express` stays installed: the adapter extends its `ExpressAdapter`.

```ts
import { NestFactory } from "@nestjs/core";
import { FulmineExpressAdapter } from "fulmine.js/nest";
import { AppModule } from "./app.module";

const app = await NestFactory.create(AppModule, new FulmineExpressAdapter());
await app.listen(3000);
```

Where the app needs options, TLS being the usual reason, build it and pass it:

```ts
import express from "fulmine.js";

new FulmineExpressAdapter(express({ uwsOptions: { key_file_name: "key.pem", cert_file_name: "cert.pem" } }));
```

## How fast

One Nest application, the same controller on the three adapters: a route answering text and one
answering JSON with a route parameter.

| Adapter                    | text      | JSON with a parameter |
| -------------------------- | --------- | --------------------- |
| `@nestjs/platform-express` | 10.7k     | 9.4k                  |
| `@nestjs/platform-fastify` | 27.8k     | 19.4k                 |
| `FulmineExpressAdapter`    | **52.6k** | **45.6k**             |

Requests per second, Nest 12, Node 24, Fastify 5.12, one core for the server, autocannon with 50
connections on other cores, median of five rounds with the adapters taken in turn. A second
Fulmine arm in the same rounds, as a control, landed within 2% of the first. So about 4.8x the
Express adapter and 2x the Fastify one, without leaving the Express API: a Fastify application
needs Fastify plugins where this one keeps its Express middleware.

The gap is the server, not Nest. Nest's own work per request is the same code on all three, which is
also why a route that waits on a database gains less. [Performance](./performance.md) has where the
speed comes from and where it does not.

## What is different

- **The app is the server.** Nest's Express adapter wraps the instance it is given in
  `http.createServer()`. This one hands Nest the app itself, which already answers as an
  `http.Server`, so requests go through µWS and never through node.
- **`httpsOptions` is refused** with an error, rather than starting a plaintext server. TLS belongs
  to µWS and is set on the app, as above.
- **`forceCloseConnections` has nothing to close.** The sockets belong to µWS and nothing emits
  `connection`, so it logs a warning instead. `app.close()` stops accepting and waits for the
  requests in flight; an idle keep-alive connection is closed by µWS after its fixed 10 seconds.
- **Nest's body parsers are added once.** Nest looks for them in `app.router.stack`, which does not
  exist here, so the adapter remembers instead of adding a second pair.

## WebSocket gateways

A gateway on the application's own port does not connect: Nest's WebSocket adapter waits for the
`upgrade` event of a node server, and here the upgrade goes to µWS. With `@nestjs/platform-ws` the
client gets a 404. Two ways that work:

- **A gateway on its own port**, `@WebSocketGateway(8081)`, brings its own node server and answers
  as before.
- **[`app.ws()`](./websockets.md) on the same port**, registered on the instance before `listen()`,
  outside Nest's gateway decorators:

```ts
const app = await NestFactory.create(AppModule, new FulmineExpressAdapter());
app.getHttpAdapter()
    .getInstance()
    .ws("/live", {
        message(ws, message, isBinary) {
            ws.send(message, isBinary);
        }
    });
await app.listen(3000);
```

## Tested

Every CI run serves a Nest application, a controller with a pipe, a body and an exception filter,
on Express and on Fulmine, and compares what they answer: [the integration
case](../integrations/cases/nest.js). The adapter has its own unit test against Nest 12.
`@nestjs/platform-express` 10 and later is accepted as a peer dependency.
