---
description: "Runnable examples of what fulmine.js does beyond Express: cluster, WebSockets, socket.io, MCP, compression, pre-compressed static files, HTTPS, PROXY protocol, tracing."
---

# Examples

One runnable file for each thing fulmine.js does that Express does not, or does differently.
What an Express app already does, routers, view engines, sessions, uploads, works unchanged and
is documented by Express itself.

| Use case                                                               | How                                            |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| [Keep a route on the fast path](./fast-routes)                         | `express.testing.expectNative()`               |
| [One process per core on one port](./cluster)                          | `express({ cluster: "auto" })`                 |
| [A database pool per cluster worker](./cluster-pool)                   | `app.cluster.share(40)`                        |
| [WebSockets next to your Express routes](./websocket)                  | `app.ws("/room/:id", { open, message })`       |
| [socket.io on uWebSockets.js](./socket-io)                             | `io.attachApp(app.uwsApp)`                     |
| [An MCP server on Express](./mcp)                                      | the official SDK, Streamable HTTP              |
| [Serve the .br and .gz files your build wrote](./static-precompressed) | `express.static(dir, { preCompressed: true })` |
| [Compression without the compression package](./compression)           | `app.use(express.compression())`               |
| [See how a request was routed in Server-Timing](./server-timing)       | `app.use(express.serverTiming())`              |
| [HTTPS without https.createServer](./https)                            | `express({ uwsOptions })`                      |
| [Client IP behind HAProxy, AWS NLB, nginx or Envoy](./proxy-protocol)  | `app.set("trust proxy protocol", true)`        |
| [Graceful shutdown](./graceful-shutdown)                               | `app.listen()` answers as an `http.Server`     |
| [Trace requests with diagnostics_channel](./monitoring)                | `express.router.request`, `http.server.*`      |
| [Run on node:http, node:http2, Bun and Deno](./node-http)              | `http.createServer(app)`                       |
| [DELETE with a JSON body](./body-methods)                              | `app.set("body methods", ["DELETE"])`          |
| [Move a project from Express](/migrating)                              | `npx fulmine.js migrate`                       |
| [See what listen() decided](/performance)                              | `npx fulmine.js profile` and `explain`         |

The files are in the [examples directory](https://github.com/nigrosimone/fulmine.js/tree/main/examples) of the repository.
