# Working on Fulmine

The README is for people using this. This is for people changing it.

The product is two things at once: answering exactly as Express does, and answering faster than
Express. A change may not lose either. Answering differently is a bug even when the new answer
reads better, since an application written for Express is what this runs; being slower than what it
replaces is a bug too, since a drop-in replacement that is not faster has no reason to exist. So a
behaviour change needs a comparison test, and a change on a path a request walks needs a number
from `npm run benchmark:ab -- --against <ref>` before it is committed. When the two pull against
each other, compatibility wins and the time is found somewhere else.

```sh
npm test                  # the comparison suite: every test runs against Express, then against
                          # Fulmine, and the two outputs have to match byte for byte
npm test middlewares      # one category
npm test tests/tests/res/res-send.js   # one file
npm test -- --self        # every file twice against this framework, the reference arm with its
                          # optimizer off, so a difference is the optimizer and not Express

npm run test:unit         # the pure functions, which the comparison cannot reach
npm run test:types        # the TypeScript declarations, through tsd
npm run typecheck         # checkJs over src, which is where the JSDoc types are checked

npm run lint              # eslint, including the rule that every function in src carries a JSDoc block
npm run format            # prettier
npm run cover             # the comparison suite under nyc, then an HTML report

npm run fuzz              # random applications, compared against Express
npm run fuzz -- --self    # the same, against itself with the optimizer off
npm run fuzz:wire         # the request bytes written by hand, compared against node's parser
npm run fuzz:headers      # every value that breaks a header block, through the methods that write one
npm run fuzz:session      # a sequence down one keep-alive connection, and down one connection each

npm run benchmark:compare -- --duration 20      # against Express, scenario by scenario
npm run benchmark:ab -- --against main          # this working tree against another revision
npm run benchmark:profile -- --scenario api-endpoint   # where the time goes, for a change ab cannot see

npm run test:express                            # Express's own test suite, run against this
npm run test:express -- res.sendFile --verbose  # one area of it, with mocha's output

npm run integrations:install                    # the frameworks that build on Express, beside the project
npm run test:integrations                       # the same application on Express and on this
```

The comparison suite is the load-bearing one. A test is a file that prints; the runner executes it
twice, once with `express` and once with this, and fails on any difference. That is why adding a
test means writing something that prints what you want compared, and why a test that prints from
both the server and the client at once is a bug: the two orderings are a race.

### Writing a comparison test

A test file is an ordinary script. The first line is its description, the second may carry a marker,
and the rest sets up an app, makes requests and prints. `tests/helpers.js` has what to print with:

|                           |                                                                                                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchTest(url, init)`    | `fetch`, plus a line with the status and the headers worth comparing. Returns the response untouched, so the test goes on to read the body as it would have. Lines come out in call order, never in arrival order.                                          |
| `sequential([() => ...])` | Runs requests one at a time. `Promise.all` starts them together and the two servers then answer in whatever order they scheduled, which is a difference the runner would report as a failure.                                                               |
| `// INSPECT`              | On the second line. The runner then mounts `inspectRequest` in front of every app the file makes, and each request prints its `method`, `url`, `originalUrl`, `baseUrl`, `path`, `protocol`, `secure`, `hostname`, `host`, `xhr`, `subdomains` and `query`. |
| `// OFF: reason`          | Skips the file.                                                                                                                                                                                                                                             |

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

A file written for the compiled path has to pin it, or it stops covering it without ever failing:
`etag` is on by default and a response that would carry one is never compiled, which had quietly
turned six of those files into ordinary-path tests. Set `app.set("etag", false)` and name the routes
with `expectDeclarative`, guarded by `if (express.testing)` so the Express arm skips it and both arms
still print the same thing.

```js
if (express.testing) express.testing.expectDeclarative(app, ["/compiled", "/also-compiled"]);
```

`npm run test:express` is the other kind of test: it clones Express at the version in
`devDependencies`, points its entry at this source and runs its suite against it. Locally it is a
bug mine and its exit status says nothing; with `--ci`, which is how it runs in CI, it is a gate,
red on any failing test or any file without a result. Read the header of `tools/express-suite.js`
before reading its numbers: some of what it reports is Express testing its own internals, which the
clone still has, and some is internals used as public API.

`npm run test:integrations` is the comparison suite again, with a framework on top. Nest, Next,
Astro, SvelteKit, React Router, Apollo and tRPC each serve one application, once on Express and once
here, and the two outputs have to match. It lives in [`integrations/`](./integrations) rather than in
`tests/` because those dependencies are frameworks rather than middlewares: heavy, installed on their
own, four of them needing their own build to run first, and none of it something `npm test` should
ask for. Read [`integrations/README.md`](./integrations/README.md) before adding a case.

It earns its keep. Two runs, two real bugs, both in the gap a hand-written test does not reach:
`req.body` was on every request where Express has none, which broke every tRPC mutation, and missing
where Express has one, which Apollo answers with a 500; and `res.writeHead` was setting headers the
way `res.set` does, so a content-type given to it came back with a charset Express never adds, on
every page Astro and SvelteKit rendered.

### A bug that is a security bug

Read [`SECURITY.md`](./SECURITY.md) before doing anything else with it, and do not open a public
issue for something exploitable. Two things it asks for are worth repeating here, because they
decide who fixes it:

- **Find out which layer it is.** Serve the same request from a bare µWebSockets.js application,
  with nothing of this project in it. If the answer is the same, the request line, the header block
  or the chunked framing is what decided it, and that is µWS's parser: it belongs at
  [uNetworking/uWebSockets.js](https://github.com/uNetworking/uWebSockets.js/issues), and no change
  here can fix it. `npm run fuzz:wire` is the tool for telling the two apart, since its oracle is
  node's parser rather than Express.
- **Everything above the parser is ours**: routing, the request and response API, the body parsers,
  the static files, the cookies. A request that reaches a route it must not reach, or a header of
  one request affecting another, is a bug in this repository whatever µWS did with the bytes.

`npm run fuzz` is the third kind: it builds random applications, registers them on Express and on
this, and compares the answers. A divergence prints the seed that reproduces it and the case shrunk
to the few lines worth keeping. Twenty rounds on a random seed run on every push.

What it finds gets fixed, with a comparison test under `tests/tests/` like any other fix. This holds
for a divergence that has nothing to do with what you were working on: the round found it, and the
next run will only find it again. When it is not going to be fixed, open an issue with what
diverges, the seed that replays it and the reason it was left, so the decision is written down
somewhere other than a terminal that has scrolled.

`--self` is the fourth, and it is the only one with no oracle in it. Both `npm test -- --self` and
`npm run fuzz -- --self` serve the same application twice with this framework, the reference arm
with `native routes` off so every request walks the ordinary chain. Each native registration,
compiled response and granted skip is a claim that µWS answering by itself gives what the chain
would have given, and that claim is where the bugs have been. A divergence there is a bug by
construction: the same code answered the same request two ways. Nothing about Express bounds it,
which is why it is worth running over the whole comparison corpus and not only over generated
applications, the corpus already holds the view engines, sessions, uploads and real middleware
nobody would think to generate.

Three more fuzzers take the surfaces `fuzz.js` cannot reach through `fetch`. `fuzz:wire` writes the
request bytes by hand, since undici will not send a malformed one, and its oracle is node's parser
rather than Express: serving more requests out of the same bytes than node is the desync smuggling
is made of. `fuzz:headers` puts every value that breaks a header block through the methods that
compute one, `res.cookie` and `res.location` and the rest, since `res.set` is the only door that is
already guarded. `fuzz:session` asks the same sequence twice, down one keep-alive connection and
down one connection each, so an answer that changed for having followed another request is a finding
of its own rather than a difference from Express.

[`tools/README.md`](./tools/README.md) covers all five and the release script.
[`benchmark/README.md`](./benchmark/README.md) covers measuring, including why the A/B runs
pipelined by default, why a null control matters, and how a run is compared against the last one on
the same machine.
