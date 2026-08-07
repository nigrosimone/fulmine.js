# tools

Three programs that are not the library and not its tests. Two of them look for compatibility bugs
from the outside; the third publishes.

Each file's own header carries the detail, including what it got wrong before it was fixed. This is
the map.

|                                        | what it is                                    | run it                  |
| -------------------------------------- | --------------------------------------------- | ----------------------- |
| [`fuzz.js`](fuzz.js)                   | random applications, compared against Express | `npm run fuzz`          |
| [`express-suite.js`](express-suite.js) | Express's own test suite, run against this    | `npm run test:express`  |
| [`release-local.js`](release-local.js) | the first publish, from a logged-in machine   | `npm run release:local` |

## fuzz.js

Builds a random application, registers it on real Express and on Fulmine, throws hostile URLs at
both, and compares status, headers and body. A disagreement is a compatibility bug in one of them,
and it is usually ours.

```bash
npm run fuzz                        # a few hundred rounds on a seed nobody chose
npm run fuzz -- --rounds 500        # longer
npm run fuzz -- --seed 12345 --rounds 1   # replay exactly what a past run did
npm run fuzz -- --keep-going        # do not stop at the first divergence
```

Two things make it a tool rather than a lucky script. Every round is drawn from a seeded generator,
so a failure prints the seed that reproduces it. And the failure is then **shrunk**: routes and
settings are dropped one at a time for as long as the divergence survives, which turns a forty route
accident into the two lines worth pasting into `tests/`.

It runs in CI on every push, twenty rounds on a random seed, and turns that job red when it finds
something. Nothing is blocked by it: read the seed, replay it locally, and decide whether it is a
bug or something the fuzzer needs taught. Every divergence it has reported so far was a real bug.

What it draws from: route shapes including the 161 patterns lifted from `path-to-regexp`'s own test
cases, mounted routers three deep, sub-apps, `app.route()`, settings, body parsers, static mounts,
view engines, ranges, proxies, declarative-compiled routes, and the routes the usage analysis can
grant skips to. What it deliberately does not: aborted requests, TLS, and pipelined connection
reuse.

## express-suite.js

Clones `expressjs/express` at the tag matching the installed `express` devDependency, swaps its
`index.js` for one that requires `src/index.js` from here, and runs mocha one file at a time.

```bash
npm run test:express                    # every file
npm run test:express -- res.sendFile    # only the files whose name contains this
npm run test:express -- --express       # the same run against Express itself, as a control
npm run test:express -- --verbose       # print mocha's output for the files that failed
npm run test:express -- --ci            # red on any failure
npm run test:express -- --refresh       # throw the clone away and take it again
```

It was a bug mine first and became a gate second. With `--ci` it is red on any failing test, any
file without a result, or a moved Express tag, which is possible only because the count reached
1130 passing and **zero** failing: a nonzero floor would need a list of expected failures, and that
rots the moment either project moves.

Two caveats keep their marks in the table. Rows marked `lib` are tests that import Express's own
`lib/`, so they exercise Express as much as us. Rows marked `exit` hung at exit on Windows, which is
a libuv bug in Node 24 and later rather than a test failure: the summary had already been printed,
and the counts are good.

## release-local.js

The first publish of a version, from a machine logged in to npm. Later ones go through the Release
workflow instead.

```bash
node tools/release-local.js 5.0.0-rc.1 --dry-run      # rehearse, change nothing
node tools/release-local.js 5.0.0-rc.1
node tools/release-local.js 5.0.0-rc.1 --skip-tests   # after a publish that failed at the end
```

Everything that can fail happens before anything becomes public, and the tag is pushed only once npm
has accepted the package.
