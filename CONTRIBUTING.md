# Working on Fulmine

The README is for people using this. This is for people changing it.

```sh
npm test                  # the comparison suite: every test runs against Express, then against
                          # Fulmine, and the two outputs have to match byte for byte
npm test middlewares      # one category
npm test tests/tests/res/res-send.js   # one file

npm run test:unit         # the pure functions, which the comparison cannot reach
npm run test:types        # the TypeScript declarations, through tsd
npm run typecheck         # checkJs over src, which is where the JSDoc types are checked

npm run lint              # eslint, including the rule that every function in src carries a JSDoc block
npm run format            # prettier
npm run cover             # the comparison suite under nyc, then an HTML report

npm run benchmark:compare -- --duration 20      # against Express, scenario by scenario
npm run benchmark:ab -- --against main          # this working tree against another revision

npm run test:express                            # Express's own test suite, run against this
npm run test:express -- res.sendFile --verbose  # one area of it, with mocha's output
```

The comparison suite is the load-bearing one. A test is a file that prints; the runner executes it
twice, once with `express` and once with this, and fails on any difference. That is why adding a
test means writing something that prints what you want compared, and why a test that prints from
both the server and the client at once is a bug: the two orderings are a race.

### Writing a comparison test

A test file is an ordinary script. The first line is its description, the second may carry a marker,
and the rest sets up an app, makes requests and prints. `tests/helpers.js` has what to print with:

|                         |                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchTest(url, init)`  | `fetch`, plus a line with the status and the headers worth comparing. Returns the response untouched, so the test goes on to read the body as it would have. Lines come out in call order, never in arrival order.                                          |
| `sequential([() => …])` | Runs requests one at a time. `Promise.all` starts them together and the two servers then answer in whatever order they scheduled, which is a difference the runner would report as a failure.                                                               |
| `// INSPECT`            | On the second line. The runner then mounts `inspectRequest` in front of every app the file makes, and each request prints its `method`, `url`, `originalUrl`, `baseUrl`, `path`, `protocol`, `secure`, `hostname`, `host`, `xhr`, `subdomains` and `query`. |
| `// OFF: reason`        | Skips the file.                                                                                                                                                                                                                                             |

`// INSPECT` is not free everywhere, which is why it is asked for rather than always on. It is a
middleware, so a route behind it stops being compiled into a declarative response and is served by
the ordinary path instead: a file whose routes do compile would quietly stop covering the compiled
one. And Express builds its router at the first `use()`, freezing `strict routing` and
`case sensitive routing` as they are at that moment, so a file that sets either one afterwards must
not ask for it. Nor may a file that fetches concurrently: the `[req]` line is printed when the
request arrives, and `Promise.all` lets the arrivals race, while `fetchTest` orders its own lines by
taking an index at call time, which nothing running server side can do. Use `sequential()` there.
Everywhere else it is worth having: it is what caught a pathless mount dropping the middleware in
front of it.

The marker is read from the comment block at the top of the file, so it can sit under a description
that runs to a paragraph rather than only on the second line.

`npm run test:express` is the other kind of test: it clones Express at the version in
`devDependencies`, points its entry at this source and runs its suite against it. Locally it is a
bug mine and its exit status says nothing; with `--ci`, which is how it runs in CI, it is a gate,
red on any failing test or any file without a result. Read the header of `tools/express-suite.js`
before reading its numbers: some of what it reports is Express testing its own internals, which the
clone still has, and some is internals used as public API.

`npm run fuzz` is the third kind: it builds random applications, registers them on Express and on
this, and compares the answers. A divergence prints the seed that reproduces it and the case shrunk
to the few lines worth keeping. Twenty rounds on a random seed run on every push.

[`tools/README.md`](./tools/README.md) covers those two and the release script.
[`benchmark/README.md`](./benchmark/README.md) covers measuring, including why the A/B runs
pipelined by default, why a null control matters, and how a run is compared against the last one on
the same machine.
