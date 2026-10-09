---
description: Attach Sentry and other tracers to Fulmine.js, on µWS and through node:http, with the diagnostics channels Express and Node.js publish.
---

# Monitoring

Fulmine publishes what Express and Node.js publish for tracers, on `node:diagnostics_channel`, whether `app.listen()` serves the app on µWS or `http.createServer(app)` serves it through node:

- `http.server.request.start`, `http.server.response.created` and `http.server.response.finish`, node:http's own. On µWS the server in them is the app `listen()` returns, and every request goes through its `emit("request")`, as node sends it.
- `express.router.request`, the TracingChannel Express's router publishes for every middleware, route handler and error handler ([pillarjs/router#196](https://github.com/pillarjs/router/pull/196)).

Without a subscriber they cost nothing. A tracer has to subscribe before `listen()`: routes µWS can answer on its own are compiled then, and none is while something listens, so every handler runs.

## Sentry

As for Express: initialise Sentry first, then add its error handler after the routes.

```js
// instrument.js, loaded before anything else
const Sentry = require("@sentry/node");

Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1.0 });
```

```js
// app.js
require("./instrument.js");
const Sentry = require("@sentry/node");
const express = require("fulmine.js");

const app = express();

app.get("/", (req, res) => {
    res.send("Hello World");
});

// after the routes, before your own error handlers
Sentry.setupExpressErrorHandler(app);

app.listen(3000);
```

Tested with `@sentry/node` 11.6, on `app.listen()` and on `http.createServer(app)`, against the same app on Express:

- an error thrown in a route, synchronous or after an `await`, is reported with the request: method, URL and the route as the transaction name;
- each request has its own scope, so `Sentry.setTag()` in a middleware stays with its request, with requests running at the same time.

What is not there yet: a span per middleware and route handler. Sentry draws those for Express by patching the `express` module, which Fulmine is not. Once Sentry reads `express.router.request`, the channel Express's router now publishes, they come from Fulmine too, with nothing to change here.

## Other tracers

A tracer that reads the channels above sees Fulmine as it sees Express. One that patches node's `http` module, as OpenTelemetry's HTTP instrumentation does, sees the requests only through `http.createServer(app)`, where node itself serves them.
