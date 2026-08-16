# tools

Six programs that are not the library and not its tests. Five of them look for compatibility bugs
from the outside; the sixth publishes.

Each file's own header carries the detail, including what it got wrong before it was fixed. This is
the map.

|                                        | what it is                                    | run it                  |
| -------------------------------------- | --------------------------------------------- | ----------------------- |
| [`fuzz.js`](fuzz.js)                   | random applications, compared against Express | `npm run fuzz`          |
| [`wire-fuzz.js`](wire-fuzz.js)         | raw bytes, compared against node's parser     | `npm run fuzz:wire`     |
| [`header-fuzz.js`](header-fuzz.js)     | hostile values through the response API       | `npm run fuzz:headers`  |
| [`session-fuzz.js`](session-fuzz.js)   | several requests down one connection          | `npm run fuzz:session`  |
| [`express-suite.js`](express-suite.js) | Express's own test suite, run against this    | `npm run test:express`  |
| [`release-local.js`](release-local.js) | publishing by hand, when the workflow cannot  | `npm run release:local` |

## fuzz.js

Builds a random application, registers it on real Express and on Fulmine, throws hostile URLs at
both, and compares status, headers and body. A disagreement is a compatibility bug in one of them,
and it is usually ours.

```bash
npm run fuzz                        # a few hundred rounds on a seed nobody chose
npm run fuzz -- --rounds 500        # longer
npm run fuzz -- --seed 12345 --rounds 1   # replay exactly what a past run did
npm run fuzz -- --keep-going        # do not stop at the first divergence
npm run fuzz -- --self              # against itself with the optimizer off, not against Express
```

`--self` swaps the Express arm for a second copy of this framework with `native routes` off, so
every request there walks the ordinary chain. Every native registration, compiled response and
granted skip is a claim that µWS answering by itself gives the answer the chain would have given,
and that claim is where the bugs have been: an analysis reading a pattern as narrower than it is, a
route that never gets its turn, a guard that does not fire. A divergence in this mode is a bug by
construction — the same code answered the same request two ways — and it needs no oracle, so it
also reaches the shapes Express has no opinion about. Checked by putting a known bug back and
confirming it is caught: with the wildcard fix reverted, `--self --seed 220496 --rounds 1` reports
the mounted route answering where the earlier one should have.

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
grant skips to. Every round asks `GET` and `HEAD` plus one drawn verb, `QUERY` and `PATCH` included,
since those two are the ones whose body handling is least like the rest. A round that puts a body
parser in front draws one body from several shapes per parser, the empty one, the one that cannot be
parsed, a charset nobody can decode and a type the parser must leave alone among them. Handlers
cover the response methods as well as the routing: `append`, `attachment`, cookies with options,
`clearCookie`, arrays through `res.set`, buffers, `204`, and a body written in chunks.

What it deliberately does not: aborted requests, TLS, and pipelined connection reuse.

One difference must stay out of the comparison, because matching it would mean copying a fault.
**A non-ascii header value.** Express hands the string to node, whose header block turns the
character into `U+FFFD` and writes it as latin1, so `res.attachment("caffè.txt")` leaves Express as
one corrupt byte while µWS writes proper utf-8. Both compute the same value; only the wire differs.
Keep generated filenames and header values ASCII. The rest of what is not compared is in
`tests/helpers.js`: `x-powered-by`, `content-length` and `transfer-encoding`.

## wire-fuzz.js

Fuzzes the bytes rather than the API. Every other tool here speaks through `fetch`, and undici will
not send a malformed request: it normalises the header block, refuses two Content-Lengths, writes
its own chunked framing. Nothing generated could reach the HTTP parser at all, which is why the
framing bug of 2026-08-16 had to be found by writing sockets by hand.

```bash
npm run fuzz:wire                        # a few hundred cases on a seed nobody chose
npm run fuzz:wire -- --rounds 2000       # longer
npm run fuzz:wire -- --seed 12345 --rounds 1   # replay
npm run fuzz:wire -- --verbose           # every case, not only the findings
```

The oracle is node's own parser rather than Express: the question is framing, and llhttp is the
reference this project is a drop-in for. Both servers get the same routes and record what they were
asked to serve, then the same bytes go to each.

The verdict is asymmetric on purpose. Serving **more** requests out of the same bytes than node, or
serving a request node refused, is reported: that is the desync smuggling is made of. Serving fewer
is µWS refusing something, which is safe, and is only listed under `--verbose`. A blind diff would
drown in the third case, since µWS is a different parser and is allowed to be stricter.

Checked by putting a known bug back: with the framing refusal reverted, `--seed 5000 --rounds 120`
reports the appended request being served where node reads one message.

## header-fuzz.js

Hands every value that breaks a header block to every response method that computes one, and
compares the bytes against Express.

```bash
npm run fuzz:headers                        # every value against every writer
npm run fuzz:headers -- --filter cookie     # only the writers whose name contains this
npm run fuzz:headers -- --verbose           # every case, not only the disagreements
```

`res.set()` refuses a value that would split the response, and tests cover it. The other door is the
methods that write a header nobody typed: `res.cookie`, `res.location`, `res.redirect`,
`res.attachment`, `res.download`, `res.vary`, `res.links`, `res.type` and the jsonp callback name
all compute one out of something the request carried. A CRLF getting through any of them ends the
header and writes what follows as a header of its own.

Raw sockets on both sides, because `fetch` parses the answer and an injected line is a header to
undici rather than a finding. The cross product is a few hundred cases, so it sweeps rather than
samples: no seed, no shrinking, every case is already one line. Every value is ASCII, for the reason
`fuzz.js` gives above.

Checked by putting a known bug back: with the value check and the unwritable-header drop both taken
off for one header name, `--filter set` reports `INJECTED` and prints the `x-injected` header on the
wire. It found the cookie package's 1.x wording reaching an application where Express's 0.7 wording
would, which is what pinned that dependency to the version Express uses.

## session-fuzz.js

Several requests down one connection, which is the thing every other tool here throws away.

```bash
npm run fuzz:session                          # a few hundred sequences on a seed nobody chose
npm run fuzz:session -- --rounds 500          # longer
npm run fuzz:session -- --seed 12345 --rounds 1   # replay
npm run fuzz:session -- --keep-going          # do not stop at the first finding
```

Each round draws a small application and a sequence of requests, and asks them twice: once down one
keep-alive connection in order, once a connection each. That gives two verdicts, and they are not
the same question. `express.shared[i]` against `fulmine.shared[i]` is an ordinary compatibility bug.
`fulmine.shared[i]` against `fulmine.fresh[i]`, where express agrees with itself, is **state**: an
answer that changed for having followed another request, which is a header map, a parsed query, a
set of matched verbs or a response's locals kept one request too long.

The connection really is one: an agent with `maxSockets: 1` and keep-alive on, and the sockets are
counted, so a round that quietly opened a second one is reported rather than passed.

Checked by putting a known bug back: with `res.locals` made one object for the whole process,
`--rounds 20` reports STATE in three of them. It found `res.sendStatus(204)` answering with a
body and a Content-Length of ten on a compiled route, which a client frames as bodiless: those ten
bytes were read as the start of the next answer on the connection.

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

**Not how releases are made.** `.github/workflows/release.yml` does that, either dispatched from the
Actions tab or triggered by a pushed tag, and that is the path to use.

This is for the case the workflow cannot fix by itself: a release that got half way, with the
version bumped and the tag pushed and then npm refusing the package. Rerunning the workflow will not
republish a tag it has already seen, and `npm publish` by hand skips every check.

```bash
node tools/release-local.js 5.3.0 --dry-run      # rehearse, change nothing
node tools/release-local.js 5.3.0
node tools/release-local.js 5.3.0 --skip-tests   # after a publish that failed at the end
```

Everything that can fail happens before anything becomes public, and the tag is pushed only once npm
has accepted the package.
