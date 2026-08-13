# Examples

One file per thing Fulmine does that Express does not. Everything an Express application already
does, routers, view engines, sessions, uploads, is documented by Express itself and works here
unchanged, so it is not repeated: these are only the parts you would not find anywhere else.

Each file runs on its own and listens on port 3000, and the comment at the top says what to send it.

```sh
cd examples
npm install          # fulmine.js from the directory above, so this runs the working tree
node websocket.js
```

| File                                                 | What it shows                                                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [fast-routes.js](./fast-routes.js)                   | which routes uWS matches itself, which are answered without running JavaScript, and how a test holds them there |
| [cluster.js](./cluster.js)                           | `express({ cluster: "auto" })`: one worker per core, all on the same port                                       |
| [websocket.js](./websocket.js)                       | `app.ws()`, with the upgrade deciding whether the socket opens                                                  |
| [socket-io.js](./socket-io.js)                       | socket.io through `io.attachApp(app.uwsApp)`, since the upgrade never reaches node                              |
| [static-precompressed.js](./static-precompressed.js) | `express.static({ preCompressed: true })`: the `.br` and `.gz` twins on disk                                    |
| [compression.js](./compression.js)                   | `express.compression()`, which Express has none of                                                              |
| [server-timing.js](./server-timing.js)               | `express.serverTiming()`: how the request was routed, in the browser's own tools                                |
| [https.js](./https.js)                               | TLS through `express({ uwsOptions })` rather than `https.createServer()`                                        |
| [proxy-protocol.js](./proxy-protocol.js)             | `trust proxy protocol`, the PROXY preamble, and why it is off by default                                        |
| [graceful-shutdown.js](./graceful-shutdown.js)       | the app answering as an `http.Server`, and what is behind that surface                                          |

The readme's [Performance tips](../README.md#performance-tips) is the prose these go with, and
[Differences from Express](../README.md#differences-from-express) is what to read before assuming
something here behaves as it does there.
