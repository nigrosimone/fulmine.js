# The demo

What runs at **fulmine-demo.fly.dev**: a real Angular 22 application, server-side rendered, behind
an ordinary Express middleware stack. Everything in `src/server.ts` is the code you would write on
Express. The only line that differs from any other Express server is the first `import`.

It deliberately shows no throughput figure. This runs on a small shared virtual machine, so any
number would describe the machine rather than the framework; the benchmarks worth reading are the
ones other people run on hardware they describe, and the root readme links them.

## What it is made of

| Piece                                                          | What it shows                                             |
| :------------------------------------------------------------- | :-------------------------------------------------------- |
| Angular 22 SSR, `AngularNodeAppEngine`                         | the schematic's own handler, unchanged                    |
| [ng-ssr-caching](https://www.npmjs.com/package/ng-ssr-caching) | the rendered page kept and replayed, with its ETag        |
| helmet, compression, cors, express-session, morgan, on-headers | third-party middleware, unmodified, in their usual order  |
| `app.ws('/ws/:room')`                                          | the chat, which is the one thing here that is not Express |
| Server-Timing                                                  | the server's own number, drawn by the browser's DevTools  |

The weather itself comes from [open-meteo](https://open-meteo.com), so the page is rendered from
real data rather than a fixture, and the cache is therefore caching something that can go stale.

The application is [Alicia Sykes](https://github.com/Lissy93)' weather app from
[framework-benchmarks](https://github.com/lissy93/framework-benchmarks), MIT licensed, with SSR
added and two components of our own: the server panel and the chat.

## Running it locally

```sh
cd demo
npm install
npm run build
npm start          # http://localhost:3000
```

Or the way it is deployed, which also checks the glibc and git constraints µWS brings:

```sh
docker build -t fulmine-demo .
docker run --rm -p 3000:3000 -e NG_ALLOWED_HOSTS=localhost fulmine-demo
```

### `ng build` crashes on Windows, and it is not Angular

The build ends with a segmentation fault, after producing everything except the files copied from
`public/`. The cause is upstream and reproduces in three lines:

```sh
node -e "new (require('worker_threads').Worker)('require(\"uWebSockets.js\")',{eval:true})"
# Segmentation fault
```

Loading the µWS native addon inside a worker thread kills the process on Windows, and Angular's
build launches the SSR entry in a worker to walk the routes. The same code is routine on Linux,
which is where the Docker build above and the deploy run, so this affects local Windows builds
only. Until it is fixed upstream, build in Docker or copy `public/` into
`dist/fulmine-demo/browser/` afterwards.

## Deploying it

Fly deploys it from this repository through its own GitHub integration, so a push to `main` is
the deployment. Its settings have to say where the demo lives, since the repository root holds
the library rather than an application:

| Field                     | Value                                          |
| ------------------------- | ---------------------------------------------- |
| App name                  | `fulmine-demo`, which is what `fly.toml` names |
| Current working directory | `demo`                                         |
| Config path               | `demo/fly.toml`                                |
| Branch                    | `main`                                         |

One secret is worth setting, because the fallback in the source is public:

```sh
fly secrets set SESSION_SECRET="$(openssl rand -hex 32)" --app fulmine-demo
```

A deploy can also be done by hand, from the repository root rather than from here, so the paths do
not have to be typed:

```sh
npm run demo:deploy    # cd demo && fly deploy
npm run demo:logs      # what the machine is saying
npm run demo:start     # installs, builds and runs it locally instead
```

The deploy changes directory rather than passing `--config`: `fly deploy ./demo --config ./demo/fly.toml`
looks correct and is not, because flyctl moves into the working directory first and then resolves the
config path inside it, so it goes looking for `demo/demo/fly.toml` and reports an app with no name.

This is what to reach for after a release: the demo depends on `fulmine.js` from npm rather than on
the source next to it, so it picks up a new version by being deployed again. A new **major** needs
the range in `demo/package.json` widened first, since `^5` will not cross to `6`.

## What is in fly.toml

- `primary_region = "fra"`, the closest region to most of the readers this demo is for.
- `auto_stop_machines = "off"` with `min_machines_running = 1`: a demo of a fast server that
  takes ten seconds to wake up would prove the opposite of the point. This is the one setting
  worth its cost here.
- `internal_port = 3000`, which is what the server listens on unless `PORT` says otherwise.
- `NG_ALLOWED_HOSTS`, because Angular refuses to render for a `Host` header it was not told
  about. The build-time list has only `localhost`, and this replaces it. A custom domain has to
  be added here, or Angular answers it with a 400.
- `memory = "512mb"`, unchanged from the static demo: the container settles at 64 MB after ten
  renders with eight pages cached, so the Angular application fits in what was already paid for.
