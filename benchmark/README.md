# Benchmark suite

Compares `express` against `fulmine` scenario by scenario. The load generator is
[autocannon](https://github.com/mcollina/autocannon), which is an ordinary dependency, so the suite
runs anywhere Node does. It used to be `wrk`, which meant Linux only and an apt package in CI.

```bash
npm run benchmark:compare -- --duration 20 --output benchmark_summary.md
```

One scenario at a time:

```bash
npm run benchmark:compare -- --duration 20 --scenario hello-world
```

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

Ratios are not comparable across runs. GitHub's runners vary enough that the same code measures
15k or 28k req/sec on the same row, so only compare figures produced in the same run.
