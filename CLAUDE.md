# Working on this repo as an agent

Fulmine.js is a drop-in Express 5 replacement on uWebSockets.js. Compatibility with Express is the
product, so "Express does X" settles almost every design argument.

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first: it explains the test suites and how to write a
comparison test. [`benchmark/README.md`](./benchmark/README.md) explains measuring.
[`tools/README.md`](./tools/README.md) covers the fuzzers, the Express suite and releasing.
[`integrations/README.md`](./integrations/README.md) covers the frameworks that build on Express.
This file only adds what those do not say.

## Before you commit

All of these are expected green. Run them, do not assume:

```sh
npm test              # comparison suite, the load-bearing one
npm run test:unit
npm run test:express  # Express's own suite; 1130 passing, 0 failing
npm run typecheck
npm run lint
npm run format:check
```

A behaviour fix needs a comparison test under `tests/tests/`, and you must check it fails without
the fix before claiming it covers anything. Reverting the fix and re-running is the only proof.

`npm run test:integrations` is the same rule with a framework on top, and it is not in the list
because it needs its own install, `npm run integrations:install`, and builds four applications the
first time. Run it when you touch anything a framework sits on: the request and response surface,
the body parsers, `writeHead`, the header methods. Both bugs it has found so far were in code the
comparison suite covers well and applications reach differently from frameworks.

Do not tag or release unless asked. Pushing a `v*` tag is what makes
`.github/workflows/release.yml` publish to npm; `npm run release` creates that tag.

## Express version policy

Test against the **released** Express only, the one in `devDependencies`. Master is out of scope.
Its unreleased behaviour changes will fail against this project by design, and the pinned suite
asserts the current behaviour, so chasing master breaks the gate it is supposed to protect.

## Measuring

Use `npm run benchmark:ab -- --against <ref>`. Do not hand-roll an A/B by checking out `src/` and
running `run.js` twice: it measures warm-up, not the change. Read the noise floor rules in
[`benchmark/README.md`](./benchmark/README.md) before quoting a number, and run `--null` from the
same sitting or the number is not evidence.

Some changes need no benchmark at all. If the code sits behind a guard most applications never
reach, say which guard and move on. Anything under about 20 ns per request is below what matters
against a request budget of tens of microseconds.

Never run anything else on the machine while a benchmark measures. If the Express column moved
between two runs, the machine moved and the run is void.

## The fuzzers

`npm run fuzz` compares random applications against Express. It is the highest-yield bug finder
here. Triage a run by grouping the divergences by which fields differ: one root cause usually
accounts for most of them. Replay with `--seed <n> --rounds 1` and read the shrunk case it prints.

`fuzz:wire`, `fuzz:headers` and `fuzz:session` take what it cannot reach through `fetch`: the
request bytes, the methods that compute a header value, and a sequence down one keep-alive
connection. Run the one that sits under what you changed. `tools/README.md` has each of them.

CI runs it on a **random seed**, so it explores a different application on every push. Red there is
usually a real, pre-existing bug that this push merely exposed. Read the shrunk case before assuming
the last commit caused it.

If you touched the optimizer, the overlap analysis, the guards, the granted skips, anything in
`_compileOptimizedRoutes`, then run `npm test -- --self` and `npm run fuzz -- --self`. Those serve the
same application twice with this framework, the reference arm with `native routes` off, so a
divergence is the optimizer disagreeing with the chain it stands in for rather than a compatibility
question. `CONTRIBUTING.md` explains it. Before trusting a clean run of any oracle you add, put a
known bug back and check it is caught: a self-check that cannot fail is worse than no check.

Two differences must never be compared, because matching them would mean copying a fault:

- **A non-ascii header value.** Express hands the string to node, whose header block turns the
  character into U+FFFD and writes it as latin1, so `res.attachment("caffè.txt")` leaves
  Express as one corrupt byte while uWS writes proper utf-8. Both compute the same value; only the
  wire differs. Keep fuzz filenames and header values ASCII.
- Whatever `tests/helpers.js` already lists: `x-powered-by`, `content-length`, `transfer-encoding`.

## Comparison suite gotchas

`// INSPECT` must not go on a file that fetches concurrently through `Promise.all`. The `[req]` line
is printed when the request arrives and the arrivals race, while `fetchTest` orders its own lines by
taking an index at call time, which nothing running server-side can do. Use `sequential()` instead,
or leave the marker off. This is on top of the two rules in `CONTRIBUTING.md`.

The marker is read from the leading comment block, so it can sit under a multi-line description.

On Windows every test process asserts or hangs at exit under Node 24+. `tests/win-exit-delay.cjs`
is preloaded for it. It is not a test failure.
