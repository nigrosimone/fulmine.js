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

A deploy can also be done by hand from this directory with `fly deploy`.

## What is in fly.toml

- `primary_region = "fra"`, the closest region to most of the readers this demo is for.
- `auto_stop_machines = "off"` with `min_machines_running = 1`: a demo of a fast server that
  takes ten seconds to wake up would prove the opposite of the point. This is the one setting
  worth its cost here.
- `internal_port = 3000`, which is what the server listens on unless `PORT` says otherwise.
