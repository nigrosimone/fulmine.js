---
description: Check Fulmine.js support for the Express 5 API, middleware and frameworks, with documented limitations and integrations tested against Express.
---

# Compatibility with Express 5

In general, basically all features and options are supported. Use the [Express 5.x documentation](https://expressjs.com/en/5x/api.html) for API reference. Anything Express 5 removed is removed here too, so the list below covers only where this differs from Express 5 itself.

✅ - Full support (all features and options are supported)  
🚧 - Partial support (some options are not supported)  
❌ - Not supported

## express

- ✅ express()
- ✅ express.Router()
- ✅ express.json()
- ✅ express.urlencoded()
- ✅ express.static()
-   - ✅ options.index, options.redirect, options.fallthrough, options.extensions
-   - ✅ options.dotfiles, plus `"ignore_files"`, which is Fulmine's own: it hides a dotfile that is the last segment while letting a dotted directory through
-   - ✅ options.setHeaders, options.headers
-   - ✅ options.etag, options.lastModified, options.maxAge, options.immutable, options.cacheControl, options.acceptRanges
-   - ✅ options.preCompressed, Fulmine's own: serve the `.br` or `.gz` twin on disk, described under [Performance tips](./performance.md#performance-tips)
- ✅ express.text()
- ✅ express.raw()
- ✅ express.serverTiming(). Fulmine's own: Server-Timing carrying how the request was routed, described under [Performance tips](./performance.md#performance-tips).
- ✅ express.testing. Fulmine's own: `expectNative`, `expectDeclarative`, `routeReport`, `expectLazy` and `workReport`, described under [Performance tips](./performance.md#performance-tips).
- ✅ express.compression(). Fulmine's own, since Express has none: it is the [compression](https://npmjs.com/package/compression) module's options and behaviour built in, described under [Performance tips](./performance.md#performance-tips).
- 🚧 express.request (this is not a constructor but a prototype for replacing methods)
- 🚧 express.response (this is not a constructor but a prototype for replacing methods)
- 🚧 express.application (likewise: a method added here is on every app)
- ✅ express.Route. Both `app.route("/path").get(...).post(...)` and the class itself, for building a route by hand and dispatching to it.

## Application

- ✅ app.listen(port[, host][, callback])
- ✅ app.listen(unix_socket[, callback])
- ✅ app.METHOD() (app.get, app.post, etc.)
- ✅ app.route()
- ✅ app.all()
- ✅ app.use()
- ✅ app.mountpath
- ✅ app.set()
- ✅ app.get()
- ✅ app.enable()
- ✅ app.disable()
- ✅ app.enabled()
- ✅ app.disabled()
- ✅ app.path()
- ✅ app.param(name, callback)
- ✅ app.engine()
- ✅ app.render()
- ✅ app.locals
- ✅ app.settings
- ✅ app.engines
- ✅ app.on("mount")
- ✅ HEAD method
- ✅ OPTIONS method
- ✅ QUERY method

What `listen()` hands back is the app, and it answers as an `http.Server` so the shutdown wrappers
recognise it: `app.close()`, `app.address()`, `app.listening`, `app.getConnections()`, `app.ref()`,
`app.unref()`, `app.setTimeout()` and the `keepAliveTimeout` family. See
[Differences from Express](./differences.md) for what is behind them and what is not.

## Application settings

- ✅ case sensitive routing
- ✅ env
- ✅ etag
- ✅ jsonp callback name
- ✅ json escape
- ✅ json replacer
- ✅ json spaces
- ✅ query parser
- ✅ strict routing
- ✅ subdomain offset
- ✅ trust proxy
- ✅ views
- ✅ view cache
- ✅ view engine
- ✅ x-powered-by

Two of these keep a compiled form alongside the value, which you can also set directly:

- `etag fn`, the function that produces an ETag. Setting `etag` compiles one; setting this replaces it.
- `query parser fn`, likewise for `query parser`.

Fulmine adds nine of its own:

- `body methods`, unset by default. The body is read for POST, PUT, PATCH and QUERY, and this names the methods to read one for as well: `app.set("body methods", ["DELETE"])`. Reading a body no handler asks for costs about 15%, which is why the built-in list is short rather than every method.
- `native routes`, on by default. Off, every request walks the ordinary chain instead of letting µWS match what it can, which is slower and answers the same. It is a diagnostic rather than a tuning knob: it exists so one application can be served both ways and the two sets of answers compared, which is how the optimizer is tested. A compiled response needs a native registration to hang on, so turning this off turns `declarative responses` off with it.
- `etag methods`, unset by default. Express computes the generated ETag for every method, and so does this until told otherwise. `app.set("etag methods", ["GET", "HEAD"])` skips the digest on every other method, where freshness is not defined and the validator can never match: worth 21% here on a 4KB POST answer. An ETag set by hand still goes out whatever the method.
- `declarative responses`, on by default. Lets a simple enough handler be compiled into a native uWS response, described under [Performance tips](./performance.md#performance-tips).
- `declarative request values`, off by default. Lets a compiled response carry a piece of the request, `res.send(req.params.id)`, written by uWS as it reads it and not as Express does; what changes is listed under the same tips.
- `connection headers`, on by default. Express sends `Connection: keep-alive` and `Keep-Alive` on every response, and so does this. Turn it off and neither goes out, while a connection the client asked to close still answers `Connection: close`: it is the advertisement that goes, not the truth. Worth 2% to 3.5% here on a route that is not compiled, plus the bytes.
- `file cache`, on by default. Small files served by `res.sendFile` come from a bounded in-process cache, checked against the file's `stat` on every request, so an edited file is never served stale. Turn it off where every request has to reach the disk, which is what a public benchmark asks of a standard entry: it was worth about 4% on a 4KB file here, so the cost of turning it off is small.
- `stat cache`, off by default. Takes a duration, `app.set("stat cache", "1s")`. The size and mtime of a file served by `res.sendFile` or `express.static` are remembered for that long, so a file that is asked for again inside the window costs no syscall at all. It was worth 15% on a 3KB file and 3% on a 200KB one, where the bytes are the work. What it costs is the one promise the `file cache` keeps: inside the window an edited file is served as it was, so keep the window shorter than you would notice.
- `trust proxy protocol`, off by default. Takes `req.ip` from a PROXY protocol preamble, described under [Behind a proxy](./deployment.md#behind-a-proxy). Read the warning there before turning it on.

## Request

- ✅ implements Readable stream
- ✅ req.app
- ✅ req.baseUrl
- ✅ req.body
- ✅ req.cookies
- ✅ req.fresh
- ✅ req.hostname
- ✅ req.header
- ✅ req.headers
- ✅ req.headersDistinct
- ✅ req.rawHeaders
- ✅ req.ip
- ✅ req.ips
- ✅ req.method
- ✅ req.url
- ✅ req.originalUrl
- ✅ req.params
- ✅ req.path
- ✅ req.protocol
- ✅ req.query
- ✅ req.res
- ✅ req.secure
- ✅ req.signedCookies
- ✅ req.stale
- ✅ req.subdomains
- ✅ req.xhr
- 🚧 req.route (route implementation is different from Express)
- 🚧 req.connection, req.socket (only `end()`, `encrypted`, `remoteAddress`, `remotePort` and `localPort` are supported)
- ✅ req.accepts()
- ✅ req.acceptsCharsets()
- ✅ req.acceptsEncodings()
- ✅ req.acceptsLanguages()
- ✅ req.get()
- ✅ req.is()
- ✅ req.range()

## Response

- ✅ implements Writable stream
- ✅ res.app
- ✅ res.headersSent
- ✅ res.req
- ✅ res.locals
- ✅ res.append()
- ✅ res.attachment()
- ✅ res.cookie()
- ✅ res.clearCookie()
- ✅ res.download()
- ✅ res.end()
- ✅ res.format()
- ✅ res.getHeader(), res.get()
- ✅ res.json()
- ✅ res.jsonp()
- ✅ res.links()
- ✅ res.location()
- ✅ res.redirect()
- ✅ res.render()
- ✅ res.send()
- ✅ res.sendFile()
-   - ✅ options.maxAge
-   - ✅ options.root
-   - ✅ options.lastModified
-   - ✅ options.headers
-   - ✅ options.dotfiles
-   - ✅ options.acceptRanges
-   - ✅ options.cacheControl
-   - ✅ options.immutable
-   - ✅ Range header
-   - ✅ Setting ETag header
-   - ✅ If-Match header
-   - ✅ If-Modified-Since header
-   - ✅ If-Unmodified-Since header
-   - ✅ If-Range header
- ✅ res.sendStatus()
- ✅ res.header(), res.setHeader(), res.set()
- ✅ res.status()
- ✅ res.type()
- ✅ res.vary()
- ✅ res.removeHeader()
- ✅ res.write()
- ✅ res.writeHead()
- ✅ res.flushHeaders()

## Router

- ✅ router.all()
- ✅ router.METHOD() (router.get, router.post, etc.)
- ✅ router.route()
- ✅ router.use()
- ✅ router.param(name, callback)
- ✅ options.caseSensitive
- ✅ options.strict
- ✅ options.mergeParams

## Tested middlewares

Almost all middlewares that are compatible with Express are compatible with Fulmine. Here's list of middlewares that we test for compatibility:

- ✅ [express-fast-json-stringify](https://npmjs.com/package/express-fast-json-stringify)
- ✅ [socket.io](https://npmjs.com/package/socket.io) (via `io.attachApp(app.uwsApp)`, see [WebSockets](./websockets.md#socket-io))
- ✅ [body-parser](https://npmjs.com/package/body-parser) (use `express.text()` etc instead for better performance)
- ✅ [cookie-parser](https://npmjs.com/package/cookie-parser)
- ✅ [cookie-session](https://npmjs.com/package/cookie-session)
- ✅ [compression](https://npmjs.com/package/compression) (use `express.compression()` instead for better performance)
- ✅ [serve-static](https://npmjs.com/package/serve-static) (use `express.static()` instead for better performance)
- ✅ [serve-index](https://npmjs.com/package/serve-index)
- ✅ [cors](https://npmjs.com/package/cors)
- ✅ [errorhandler](https://npmjs.com/package/errorhandler)
- ✅ [method-override](https://npmjs.com/package/method-override)
- ✅ [multer](https://npmjs.com/package/multer)
- ✅ [response-time](https://npmjs.com/package/response-time)
- ✅ [express-fileupload](https://npmjs.com/package/express-fileupload)
- ✅ [express-session](https://npmjs.com/package/express-session)
- ✅ [express-rate-limit](https://npmjs.com/package/express-rate-limit)
- ✅ [express-subdomain](https://npmjs.com/package/express-subdomain)
- ✅ [vhost](https://npmjs.com/package/vhost)
- ✅ [http-proxy-middleware](https://www.npmjs.com/package/http-proxy-middleware)
- ✅ [express-http-proxy](https://www.npmjs.com/package/express-http-proxy)
- ✅ [express-mongo-sanitize](https://www.npmjs.com/package/express-mongo-sanitize)
- ✅ [helmet](https://www.npmjs.com/package/helmet)
- ✅ [passport](https://www.npmjs.com/package/passport)
- ✅ [morgan](https://www.npmjs.com/package/morgan)
- ✅ [swagger-ui-express](https://www.npmjs.com/package/swagger-ui-express)
- ✅ [graphql-http](https://www.npmjs.com/package/graphql-http)
- ✅ [better-sse](https://www.npmjs.com/package/better-sse)
- ✅ [supertest](https://www.npmjs.com/package/supertest)

## Tested frameworks

The list above is middlewares. A framework built on Express is a much larger user of the Express
surface than any application is, so those have a suite of their own, in
[`integrations/`](../integrations): the same application served twice, once on Express and once here,
with the two outputs compared byte for byte. The four that render pages, and the tsoa routes, are
built first by that suite, so what is compared is what their own build produces.

- ✅ [NestJS](https://nestjs.com) through [`fulmine.js/nest`](./migrating.md#nestjs)
- ✅ [Next.js](https://nextjs.org) as a custom server, `next().getRequestHandler()`
- ✅ [Astro](https://astro.build) through `@astrojs/node` in middleware mode
- ✅ [SvelteKit](https://svelte.dev/docs/kit) through `@sveltejs/adapter-node`
- ✅ [React Router v7](https://reactrouter.com) through `@react-router/express`
- ✅ [Apollo Server](https://www.apollographql.com/docs/apollo-server) through
  [`@as-integrations/express5`](https://www.npmjs.com/package/@as-integrations/express5)
- ✅ [tRPC](https://trpc.io) through `@trpc/server/adapters/express`
- ✅ [MCP](https://modelcontextprotocol.io) through
  [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) on the
  Streamable HTTP transport, with the body read off the stream or handed over by `express.json()`.
  Runnable: [`examples/mcp.js`](../examples/mcp.js)
- ✅ [tsoa](https://tsoa-project.github.io/docs/): the routes `tsoa spec-and-routes` generates from a decorated
  controller, registered with `RegisterRoutes(app)`, validation errors included
- ✅ [Angular SSR](./migrating.md#angular-ssr), which is an ordinary Express `server.ts` plus one line of build
  configuration

Each of these mounts on an ordinary Express application, so there is nothing to install and nothing
to configure beyond what that framework already asks for. Nest is the exception, and only because
its adapter decides what to listen on: that one is [`fulmine.js/nest`](./migrating.md#nestjs).

## Tested view engines

Any Express view engine should work. Here's list of engines we include in our test suite:

- ✅ [ejs](https://npmjs.com/package/ejs)
- ✅ [pug](https://npmjs.com/package/pug)
- ✅ [express-dot-engine](https://npmjs.com/package/express-dot-engine)
- ✅ [express-art-template](https://npmjs.com/package/express-art-template)
- ✅ [express-handlebars](https://npmjs.com/package/express-handlebars)
- ✅ [swig](https://npmjs.com/package/swig)
