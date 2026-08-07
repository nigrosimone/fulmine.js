# The demo

What runs at **fulmine-demo.fly.dev**. It shows that a Fulmine application is an Express
application: the routes, the middleware and the session are the ordinary ones, and the only line
that differs from any other Express server is the first `require`.

It deliberately shows no throughput figure. This runs on a small shared virtual machine, so any
number would describe the machine rather than the framework; the benchmarks worth reading are the
ones other people run on hardware they describe, and the root readme links them.

## Running it locally

```sh
cd demo
npm install
npm start          # http://localhost:3000
```

Or the way it is deployed, which also checks the glibc and git constraints µWS brings:

```sh
docker build -t fulmine-demo .
docker run --rm -p 3000:3000 fulmine-demo
```

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

One secret is worth setting, because this page links to its own source and the fallback in it is
therefore public:

```sh
fly secrets set SESSION_SECRET="$(openssl rand -hex 32)" --app fulmine-demo
```

A deploy can also be done by hand, from the repository root rather than from here, so the paths do
not have to be typed:

```sh
npm run demo:deploy    # cd demo && fly deploy
npm run demo:logs      # what the machine is saying
npm run demo:start     # installs and runs it locally instead
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
