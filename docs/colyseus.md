---
description: Serve the express routes of a Colyseus server with fulmine.js on the uWebSockets.js transport, in place of uwebsockets-express. Same express option, about 4x to 6x the requests per second.
---

# Colyseus

Colyseus serves its `express` routes on the uWebSockets.js transport through uwebsockets-express.
`fulmine.js/colyseus` puts Fulmine there instead: the same `express` option, the rooms and the
matchmaking as before, and the routes Fulmine can match go to uWS.

```sh
npm install fulmine.js
```

```js
const { defineServer } = require("@colyseus/core");
const { FulmineTransport } = require("fulmine.js/colyseus");
const express = require("fulmine.js");

const server = defineServer({
    transport: new FulmineTransport(),
    rooms: { my_room: MyRoom },
    express: (app) => {
        app.use(express.json());
        app.get("/hello", (req, res) => res.json({ hello: "world" }));
    }
});

server.listen(2567);
```

`FulmineTransport` is Colyseus's `uWebSocketsTransport`, so it takes the same options. The CORS
headers Colyseus adds to every express answer are added here too.

## How fast

The same server, autocannon with 100 connections, Colyseus 0.18.18 on Linux:

| Route             | uwebsockets-express | fulmine.js | Express on ws-transport |
| ----------------- | ------------------: | ---------: | ----------------------: |
| GET /hello        |                5.7k |      34.7k |                   10.6k |
| GET /users/:id    |                7.1k |      38.5k |                    9.6k |
| POST /echo (JSON) |                8.6k |      33.8k |                    8.1k |

## What to know

- The rooms are not faster: their messages go through the transport's WebSockets either way. What
  changes is the HTTP side, the routes you give to `express`.
- Colyseus pins uWebSockets.js 20.52 for older glibc, and npm installs one copy for both; Fulmine
  runs on it. That version has no build for Node.js 26, so the uWS transport does not start there,
  with or without Fulmine.
- Keep `uwebsockets-express` installed for now: without it the transport stops the process at start
  in the Colyseus releases up to 0.18.4.

Tested in CI against Colyseus's default, Express on `WebSocketTransport`: the same routes, the 404,
the CORS headers and a room message answer the same. See
[integrations/cases/colyseus.js](../integrations/cases/colyseus.js).
