# Working on this repo as an agent

Fulmine.js is a drop-in Express 5 replacement on uWebSockets.js. Two things are the product:
**compatibility with Express**, so "Express does X" settles almost every design argument, and
**being faster than Express**, which is the only reason to replace it at all. A change that answers
differently from Express is a bug even when the new answer looks better, and a change that is slower
than what it replaces is a bug even when it is correct. Where the two pull against each other,
compatibility wins and the speed is paid for somewhere else.

Everything about how to work here is in [`CONTRIBUTING.md`](./CONTRIBUTING.md): the suites, what to
run before committing, how to write a comparison test, the fuzzers, the security layer rule, the
Express version policy and the measuring rules. [`benchmark/README.md`](./benchmark/README.md),
[`tools/README.md`](./tools/README.md) and [`integrations/README.md`](./integrations/README.md) go
deeper on their own subjects. Read those rather than guessing; this file only says what an agent
gets wrong that a human reading them would not.

## What is not yours to decide

- **Do not tag or release unless asked.** `npm run release` pushes a `v*` tag and that tag publishes
  to npm.
- **Do not open an issue in another project on the maintainer's behalf**, uNetworking included. When
  a finding belongs upstream, say so in your report and stop there.
- **Do not leave a fuzz divergence behind.** It is fixed, with a comparison test, or it is written
  down in an issue with the seed. A finding that is neither is lost when the run scrolls away, and
  the next run spends its rounds on it again.

## What to say rather than assume

- **Run the gates, do not predict them.** The list is in CONTRIBUTING under "Before you commit", and
  "it cannot have broken anything" is not a result.
- **A fix is not covered until its test has failed without it.** Revert the fix, watch the test go
  red, put it back. Say that you did it, or say that you did not.
- **A number is evidence only with its control.** An A/B without a `--null` from the same sitting,
  or with anything else running on the machine, is not a measurement. If a change needs no
  benchmark, name the guard that makes it unreachable instead of implying it was measured.
- **Report what happened.** Which suites ran, which did not and why, what is still failing. A green
  summary over a suite you skipped is the one thing that makes all of the above worthless.
