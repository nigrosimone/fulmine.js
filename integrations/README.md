# Integrations

The frameworks that build on Express, each serving the same application twice: once on Express and
once on Fulmine, with the two outputs compared byte for byte. Same rule as the comparison suite in
[`tests/`](../tests), and the same reason for it. A framework is a much larger user of the Express
surface than any application is, so it reaches parts of it no test written by hand would think to
reach. The first two runs of this directory found two real bugs, and both were in that gap:

- `req.body` was on every request where Express has none, which broke every tRPC mutation, and
  missing where Express has one, which Apollo answers with a 500.
- `res.writeHead` set its headers the way `res.set` does, so a `content-type` given to it came out
  with a charset appended. It is node's method and Express does not override it. Every framework
  that renders a page builds its own response and writes it with `writeHead`, so the charset was on
  every page Astro and SvelteKit served.

```sh
npm run integrations:install   # the frameworks, and fulmine.js from the directory above
npm run test:integrations      # build what needs building, then every case
cd integrations && node run.js trpc     # just that one
cd integrations && node build.js --force  # rebuild the applications from scratch
```

| Case                                       | What it serves                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [nest.js](./cases/nest.js)                 | a Nest controller with a pipe, a body and an exception filter, through the adapter                |
| [apollo.js](./cases/apollo.js)             | Apollo Server through `@as-integrations/express5`                                                 |
| [trpc.js](./cases/trpc.js)                 | a tRPC router through `@trpc/server/adapters/express`                                             |
| [astro.js](./cases/astro.js)               | `@astrojs/node` in middleware mode, including the `next()` it calls for a path it does not answer |
| [sveltekit.js](./cases/sveltekit.js)       | the handler `@sveltejs/adapter-node` builds                                                       |
| [react-router.js](./cases/react-router.js) | React Router v7 through `@react-router/express`                                                   |
| [next.js](./cases/next.js)                 | Next.js as a custom server, `next().getRequestHandler()`                                          |

The first three are libraries: a case requires them and runs. The last four compile an application
first, so each keeps a small one in [`apps/`](./apps) and [`build.js`](./build.js) builds it before
the case runs. A build already there and newer than its sources is skipped, so running one case
twice costs nothing.

Between them the four cover both halves of the surface. Astro, SvelteKit and Next hand the node
request and response to a handler that reads the stream and writes with `writeHead`; React Router's
adapter is written for Express and goes through `res.status`, `res.set` and the response stream. The
`writeHead` bug above was only ever going to be found by the first kind.

## Writing a case

A case is one file in `cases/`. It gets its framework from [`arm.js`](./arm.js), never by requiring
`express` or `fulmine.js` directly, and that is the whole trick: the runner runs the file twice with
`INTEGRATION_ARM` set differently and the file does not know which run it is in.

Four rules, and the first three are the comparison suite's:

- **Print what is being compared.** `fetchTest` from [`tests/helpers.js`](../tests/helpers.js) prints
  the status and the headers worth comparing; the body is yours to print. A whole rendered page is
  better printed as its length: the build's asset hashes are in it, they are the same on both arms,
  and they tell a reader nothing.
- **Fetch one at a time**, through `sequential`. Two arms scheduling concurrent requests differently
  would fail as a difference that is the event loop's rather than the framework's.
- **Bind a fixed port**, written as `const PORT = 13801;` so the runner can wait for it to go quiet
  between the arms. Take the next free number.
- **Turn off anything carrying a stack trace, a path or a clock reading.** Apollo and tRPC both put
  a stack in the error body outside production; React Router logs one when no route matches; Next
  prints how long its config took to load. Each case here shows what silences its own.

Nest is the one case that also picks its adapter from `arm.js`: the Express arm uses Nest's own
`ExpressAdapter` and the Fulmine arm uses [`fulmine.js/nest`](../src/nest.js), which is the thing
being tested.

## Adding an application

Put it in `apps/<name>/`, name the case `cases/<name>.js`, and add a row to `BUILDS` in
`build.js` saying what builds it and which file proves it was built. Nothing else is wired up: the
runner matches the case name to the directory.

The applications share this directory's `node_modules` rather than each having their own, which is
the one thing to know when a build behaves oddly. It has bitten once already: Astro's server bundle
imports `cookie` and resolves it from where the bundle sits, which here finds Express's copy rather
than Astro's, so `apps/astro/astro.config.mjs` bundles that one in instead. A real project has its
own `node_modules` and never meets it.
