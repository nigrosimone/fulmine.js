---
description: Run Bull Board, Parse Server and Keystone 6 on Fulmine.js. What changes in each, the LiveQuery adapter for Parse, and the npm override for Keystone.
---

# Bull Board, Parse Server and Keystone

These three ship their own Express application, or build one inside. None of them needs a plugin
for Fulmine: what to change is below, one section each.

Bull Board is in the [integration suite](./compatibility.md#tested-frameworks), so CI runs it on
every commit. Parse Server and Keystone were run by hand, the same requests on Express and on
Fulmine with the same answers, with the versions written in each section. They need a database to
start, which is why they are not in the suite.

## Bull Board

`@bull-board/express` builds its own `express()` app, and you mount its router. On Fulmine you mount
it the same way, nothing else changes:

```js
const express = require("fulmine.js");
const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { ExpressAdapter } = require("@bull-board/express");

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");
createBullBoard({ queues: [new BullMQAdapter(queue)], serverAdapter });

const app = express();
app.use("/admin/queues", serverAdapter.getRouter());
app.listen(3000);
```

The router is a real Express application, so Express stays installed as Bull Board's dependency.
Fulmine mounts it the way Express mounts a sub-app. That needs Fulmine 5.33.1 or later: before it,
the first request to a mounted Express application crashed the process.

## Parse Server

Tried with parse-server 9.11. `new ParseServer(options).app` is an Express application, and you
mount it the same way:

```js
const express = require("fulmine.js");
const { ParseServer } = require("parse-server");

const api = new ParseServer({ databaseURI, appId, masterKey, serverURL: "http://localhost:1337/parse" });
await api.start();

const app = express();
app.use("/parse", api.app);
app.listen(1337);
```

Objects, queries, users and sessions, Cloud Code functions, files and batch requests answered the
same on Express and on Fulmine. `ParseServer.startApp()` builds its own Express app and node
server, so use the code above instead of it. Fulmine 5.33.1 or later, for the same reason as Bull
Board.

### LiveQuery

LiveQuery listens for the WebSocket upgrade on a node server. On Fulmine the upgrade is answered by
µWS and never reaches node, so `createLiveQueryServer(app)` starts without an error and then never
sees a connection. Parse lets you replace the WebSocket server with `wssAdapter`, and this one is on
[`app.ws()`](./websockets.md):

```js
const { EventEmitter } = require("events");

// what Parse calls on a socket, over a µWS socket
class Socket extends EventEmitter {
    constructor(ws) {
        super();
        this.ws = ws;
        this.open = true;
    }
    send(message) {
        if (this.open) this.ws.send(message);
    }
    ping() {
        if (this.open) this.ws.ping();
    }
    terminate() {
        if (this.open) this.ws.close();
    }
    close() {
        if (this.open) this.ws.end(1000);
    }
}

class FulmineWSAdapter {
    constructor(options) {
        this.options = options;
    }
    onListen() {}
    onConnection() {}
    onError() {}
    start() {
        const sockets = new WeakMap();
        this.options.server.ws("/", {
            open: (ws) => {
                const socket = new Socket(ws);
                sockets.set(ws, socket);
                this.onConnection(socket);
            },
            message: (ws, message) => sockets.get(ws).onmessage?.({ data: Buffer.from(message).toString() }),
            pong: (ws) => sockets.get(ws).emit("pong"),
            close: (ws) => {
                const socket = sockets.get(ws);
                socket.open = false;
                socket.onclose?.();
            }
        });
        this.onListen();
    }
    close() {}
}
```

Create the LiveQuery server before `app.listen()`, so the WebSocket route is there when µWS starts,
and give it the app:

```js
await ParseServer.createLiveQueryServer(app, { wssAdapter: FulmineWSAdapter });
app.listen(1337);
```

Connect, subscribe, the create, update and leave events and the errors were the same as with
Parse's own adapter on Express, and the connection stayed up across Parse's ping and pong.

## Keystone 6

Tried with @keystone-6/core 8.3. Keystone builds its Express app inside `keystone start`, and has no
option to hand it one. So the way in is the package manager: an
[override](./migrating.md#when-express-is-somebody-elses-dependency) makes every `require("express")`
in the project load Fulmine, Keystone's own included.

```sh
npx fulmine.js override
```

or by hand, for npm:

```json
{
    "overrides": {
        "express": "npm:fulmine.js@^5"
    }
}
```

The GraphQL API answered the same on Express and on Fulmine: queries and mutations, filters,
validation errors, Apollo's CSRF check, and the 404s.

Keystone still puts a node server around the app, with `http.createServer(app)`. Fulmine answers
that too, but [through `node:http`](./differences.md), which is the slower of its two ways in: the
fast one is the app listening by itself, and Keystone has no option for that yet. One difference
from Express shows in the headers: Fulmine does not send `X-Powered-By` unless asked with
`app.set("x-powered-by", true)`.
