---
description: Review the differences between Fulmine.js and Express 5, including server behaviour, request handling, TLS and native uWebSockets.js limitations.
---

# Differences from Express

What the two servers answer on the wire, probed from outside, malformed input and smuggling
attempts included: [fulmine.js on http-probe.com](https://www.http-probe.com/servers/fulmine-js.html)
against [express](https://www.http-probe.com/servers/express.html).

- `app.listen()` returns the app rather than a separate server object, and the app answers as an `http.Server`: `app instanceof http.Server` is true, which is what the graceful shutdown wrappers and the connection trackers look for. There is still no node server underneath, the socket belongs to µWS, so what is answered is the surface and not the plumbing. There: `close()`, `address()`, `listening`, `getConnections()`, `ref()`, `unref()`, `setTimeout()` and the `keepAliveTimeout` family. Not there: nothing emits `connection`, `request` or `upgrade`, `getConnections()` counts the requests in flight rather than sockets, and the timeouts belong to µWS and are set through `uwsOptions.idleTimeout`. Anything that wants to serve its own protocol on the socket, socket.io being the usual case, still wants `app.uwsApp`. Runnable: [`examples/graceful-shutdown.js`](../examples/graceful-shutdown.js).
- `x-powered-by` is disabled by default. Express sends `X-Powered-By: Express` unless you turn it off; Fulmine does not send it unless you turn it on with `app.set("x-powered-by", true)`. The header only tells anyone asking which framework is running.
- request body is only read for POST, PUT, PATCH and QUERY requests by default. You can add additional methods by setting `body methods` to array with uppercased methods.
- **A request whose framing cannot be trusted is refused by hanging up, with no answer at all.** Node's parser refuses each of these with a `400` and Fulmine refuses the same ones: a repeated `Content-Length`; one that is not a plain count of bytes, an empty value or a count past `Number.MAX_SAFE_INTEGER` included; a `Transfer-Encoding` whose last coding is not `chunked`; and a method nobody defines, which includes a lowercase one, since methods are case sensitive. µWS accepts all of them. It frames the request on the first length, or on no body at all, and it takes any token as a method, so `{"a":1}GET /path HTTP/1.1` is a request line to it. What the client sent as a body is then read as the next request on the connection: that is request smuggling, and a proxy in front disagreeing about the framing is all it takes. The answer differs from Express because it cannot be helped. µWS only skips the request it has already queued when the response is closed rather than completed, and writing the `400` completes it, so the choice is between telling the client and stopping the smuggled request. Nothing well behaved sends any of these.
- **A compiled route answers `connection: keep-alive` to a client that sent `Connection: close`.** A handler simple enough to be read at registration time is answered by µWS from a response written once at `listen()`, and that response cannot read the request. The socket still closes, so what is wrong is the header and not the transport. A response that would carry a validator is never compiled, so conditional requests behave as on Express; `app.set("declarative responses", false)` turns compiling off.
- **Informational responses go nowhere.** `res.writeEarlyHints()`, `res.writeContinue()` and `res.writeProcessing()` are all there, take what node's take and throw what node's throw once the head has gone out, but nothing reaches the wire: µWebSockets.js has no API for a `1xx`. They exist so that code written for Express keeps running rather than dying on "is not a function", which is the only thing a drop-in can honestly promise here. `res.addTrailers()` is the same story, and `res.setTimeout()` and `req.setTimeout()` register the listener without changing anything, since µWS runs its own idle timeout through `uwsOptions.idleTimeout`.
- For HTTPS, instead of doing this:

```js
const https = require("https");
const express = require("express");

const app = express();

https
    .createServer(
        {
            key: fs.readFileSync("path/to/key.pem"),
            cert: fs.readFileSync("path/to/cert.pem")
        },
        app
    )
    .listen(3000, () => {
        console.log("Server is running on port 3000");
    });
```

You have to pass `uwsOptions` to the `express()` constructor:

```js
const express = require("fulmine.js");

const app = express({
    uwsOptions: {
        // https://unetworking.github.io/uWebSockets.js/generated/interfaces/AppOptions.html
        key_file_name: "path/to/key.pem",
        cert_file_name: "path/to/cert.pem"
    }
});

app.listen(3000, () => {
    console.log("Server is running on port 3000");
});
```

Runnable: [`examples/https.js`](../examples/https.js).

- This also applies to non-SSL HTTP too. Use `app.listen()` rather than creating a server by hand. `http.createServer(app)` does work, because the app is a request listener like Express's and answers node's requests through a shim, which is what lets `supertest`, `vhost` and anything else that calls an app keep working. But it serves those requests through `node:http` rather than through µWS, so the speed is Express's. It is there for compatibility, not for production.
- **Node 22, 24 and 26, not every version above 22.** µWebSockets.js ships one prebuilt binary per Node ABI and skips the odd lines, so Node 23 and 25 have no binary to load and fail at `require`. `npx fulmine.js verify` says which binary this machine wants and whether it is there. The odd/even model ends with Node 26, so the gap closes on its own.
- Node.JS max header size is 16384 bytes, while uWebSockets by default is 4096 bytes, so if you need longer headers set the env variable `UWS_HTTP_MAX_HEADERS_SIZE` to max byte count you need.
- uWebSockets drops a request whose body arrives slower than 16KB/s, and the timeout is not reachable from JavaScript, while Node.JS waits as long as the client needs. Uploads over very slow connections can therefore fail here and succeed on Express. A body stalled for 5 seconds still completes; one stalled for 12 seconds gets its socket reset at around 11.8 seconds.

## HTTP/3

There is an `http3: true` option, inherited from Ultimate Express, that asks µWebSockets.js for its experimental HTTP/3 app. **It is guarded off with the currently pinned µWS build**: asking for it throws a clear error, because the underlying `H3App` segfaults during construction on Linux, verified with µWS alone before a single request is served. On Windows the listener does come up, but nothing answers over QUIC that we could verify, and shipping an option that works on no deployable platform helps nobody. A skipped canary test probes `H3App` on every CI run and will turn red the day µWS ships working QUIC in its prebuilt binaries, which is when the guard goes and this section changes.

```js
// what it would look like, once µWS's H3 support actually works
const app = express({
    http3: true,
    uwsOptions: {
        key_file_name: "/path/to/example.key",
        cert_file_name: "/path/to/example.crt"
    }
});
```
