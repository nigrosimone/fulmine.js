# Benchmark suite

Compares `express` against `fulmine` scenario by scenario. The load generator is
[autocannon](https://github.com/mcollina/autocannon).

```bash
npm run benchmark:compare -- --duration 20 --output benchmark_summary.md
```

One scenario at a time:

```bash
npm run benchmark:compare -- --duration 20 --scenario hello-world
```

Declarative responses are off while measuring, so the comparison is between two frameworks doing
the work rather than between one of them and a response uWS wrote at startup. To measure what that
shortcut is worth instead, turn it on:

```bash
FULMINE_DECLARATIVE=1 npm run benchmark:compare -- --duration 20 --scenario hello-world
```

Measured on a route simple enough to be compiled, it is worth around a fifth more throughput once
the load generator is no longer the bottleneck. Without pipelining, autocannon saturates first and
both sides read the same. It is paid for with chunked framing and no `Content-Length`.

## Comparing two revisions of this project

`run.js` answers "how does this compare to Express". `ab.js` answers a different question: "did
the change I just made move anything".

```bash
npm run benchmark:ab -- --against main
npm run benchmark:ab -- --against main --scenario routes-1000 --rounds 9
npm run benchmark:ab -- --null           # same code on both sides
```

It puts the other revision in a `git worktree` inside the repo, so both trees can be loaded at
once and node_modules still resolves, starts a server from each, and then **alternates the load
between them round by round**, swapping which one goes first. The figure to read is the median of
the per-round ratios.

Measuring one revision and then the other does not work on a machine that warms up or throttles,
and the tool can show you why: `--null` puts the same code on both sides, so whatever it reports
is noise. On the laptop this was written on, `--null` lands within about 2% of 1.0 once the two
warmup rounds are discarded, and reported 0.65x per-round before they were. **If a change moves
the median less than `--null` does on your machine, it did not move anything this can see.**

Two rounds are run and thrown away first. Whichever server is hit first is hit cold, and without
that the first recorded round came out 60% away from every round after it.

**Nine rounds do not resolve one percent.** A change measured at 0.98 over nine rounds, which read
as a real regression next to a `--null` median of 0.999, came back at 0.996 over fifteen. The median
of nine per-round ratios still wanders a percent or two on its own, so a result under about 3% needs
`--rounds 15` before it is worth believing, and a `--null` run from the same sitting to read it
against. Nine is for telling 1.2x from 1.0.

## Writing a scenario

A scenario module exports the route setup and, when the request is anything other than a plain GET,
the request itself:

```js
module.exports = {
    name: "middlewares/body-json-4kb",
    path: "/abc",
    load: {
        connections: 200, // default 200
        workers: 2 // extra generator threads, default none
    },
    request: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n: 1 })
        // or bodyRepeat: { char: "a", count: 4 * 1024 * 1024 }
    },
    bound: {
        // only for rows whose ratio is capped by work neither server performs
        by: "JSON.parse of a 512 KiB body",
        ceiling: "~1.02x"
    },
    setup(app, express, context) {
        app.post("/abc", (req, res) => res.send("ok"));
    }
};
```

`request` is deliberately one definition rather than two. It used to be a `verify` block here and a
separate `wrk` lua script, and when one of the scripts was renamed the load run quietly fell back to
`GET /` and measured a 404 for 34 published runs while validation kept passing.

## What the harness checks before it measures

- Both servers must answer the scenario's request with the same status and the same body hash.
  A mismatch marks the row and is reported under the table.
- A run that produces any non-2xx/3xx response fails rather than publishing a number.
- Socket errors and timeouts are reported under the table. Throughput measured alongside them
  reflects the generator as much as the server.
- Rows declaring `bound` are marked, with the reason and the arithmetic ceiling, so a ratio near
  1.0x reads as "this scenario cannot show a difference" rather than "these servers are the same".

## Reading the output

`NODE_ENV=production` matters: without it template engines run in debug mode and recompile the view
on every request, and `engines/art` ends up measuring the template compiler rather than either
server.

Absolute req/sec are not comparable across runs. GitHub's runners vary enough that the same code
measures 15k or 28k req/sec on the same row, so never read two runs' throughput against each other.

The speedup is the one figure that travels, because both arms ran on the same machine in the same
run: a slow neighbour or a warm cache moves them together and the ratio holds still.

## Comparing against the last run

Each run writes its ratios to `benchmark_history.json` and, if a previous run's file is there,
reports what moved since. In CI the file travels as the `benchmark-history` artifact: the workflow
downloads it from the last green run **on main**, so every run is read against the same baseline
rather than against whatever ran before it.

```bash
npm run benchmark:compare -- --duration 20            # reads and writes benchmark_history.json
npm run benchmark:compare -- --history none           # off
npm run benchmark:compare -- --history /tmp/mine.json # somewhere else
```

Runs are filed under machine and major node version, and only compared against one filed under the
same key. Both halves of that key have moved a ratio on their own before: the jump from node 22 to
24 was Express roughly tripling on some rows, which read as a regression here and was not one. When
no run exists for this exact cpu, the most recent one on a machine of the same shape is used and the
report says so, since a hosted runner pool holds more than one cpu and they do not agree.

The raw req/sec of both arms are kept next to the ratio. They are not comparable across runs, but
when a ratio does move they say which arm moved, which is the difference between a regression here
and Express getting faster.

Only rows that clear the ±10% noise floor are marked. Anything under it is weather: a table of a
dozen ratios always has one that moved a few percent.

## A unix socket instead of a port

```bash
npm run benchmark:compare -- --duration 20 --socket 1     # linux and macOS only
```

Both arms move together: µWS listens through `listen_unix` and node's server does it natively, and
autocannon dials the socket instead of the port. It is there to answer one question, whether the
loopback TCP stack is part of what makes a row move ten percent between two runs of the same code,
and it is asked rather than assumed because the answer is not free either way: the two arms need not
pay the same for a change of transport, and a ratio that moves because µWS and `node:net` differ on
AF_UNIX has stopped saying anything about the frameworks.

So run it both ways and compare the **ratios**. If they agree, the socket is a cheaper transport and
the noise it removes is real. If they do not, the transport is part of what the benchmark measures
and the port stays. The Benchmark workflow can be dispatched either way from the Actions tab.

### What running it both ways answered

Both ways on the same commit (`ac5272d`), on the same runner pool, minutes apart. They do not agree,
so the port stays and the socket is kept as a diagnostic rather than made the default.

| Test                                 | over TCP | over the socket |
| ------------------------------------ | -------: | --------------: |
| routing/routes-1000-params           |    9.83x |          16.49x |
| routing/routes-1000                  |    9.60x |          15.91x |
| routing/router-mounted-params        |    7.03x |          10.86x |
| middlewares/body-urlencoded          |    4.34x |           6.27x |
| routing/hello-world                  |    2.68x |           2.60x |
| routing/middlewares-100              |    1.85x |           1.61x |
| streaming/writable-no-content-length |    1.01x |           0.93x |

Over TCP, Fulmine lands in a 42k-49k band on every row that is only routing, whatever the row asks
it to route, while Express sits at 4.5k-16k and never approaches it. A band that tight on one arm
only is a limiter rather than a result: the loopback stack and the load generator cap the fast side,
and a ratio measured under a cap is partly a measurement of the cap. Over the socket the band opens
to 61k-87k and those rows separate by how much work each one actually saves.

It moves the other way too. `middlewares-100` and the streaming rows lose ratio on the socket, and
for the same reason read from the other end: there Fulmine is already spending its budget on its own
chain or on per-byte copying, so a cheaper transport is worth more to the arm that had room to gain.

The transport is therefore part of what these rows measure, in both directions. The published
numbers stay on TCP because that is the transport a client uses, with the caveat this run makes
concrete: on routes cheap enough to reach the cap, the published ratio is a floor.
