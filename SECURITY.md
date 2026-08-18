# Security policy

## Reporting a vulnerability

Report it privately, through
[GitHub's advisory form](https://github.com/nigrosimone/fulmine.js/security/advisories/new), or by
email to nigro.simone@gmail.com. Do not open a public issue for something exploitable.

Tell me what the bug lets an attacker do, and give me something I can run: the smallest application
that shows it and the request that triggers it are worth more than a description.

This is a project maintained by one person, so here is what to expect rather than a promise nobody
could keep: I read reports within a few days, I say whether I can reproduce it, and I tell you what
I am going to do about it. A fix goes out as a patch release, with an advisory once it is published.
If I cannot fix it, I will say that too, and why.

## What is in scope

Anything where Fulmine answers a request differently from how it should, in a way somebody can use:

- a request that reaches a route it must not reach, or reads a file outside the static root
- headers, cookies or bodies parsed in a way that lets one request affect another
- a client that can stop the server from answering everybody else, with a request nobody would call
  malformed
- `req.ip`, `req.hostname` or `req.protocol` reporting something an attacker chose, when the
  settings say they should not. `trust proxy protocol` is documented as unsafe on a public port and
  is off by default; using it there is not a vulnerability in this project

## What is not in scope

- **µWebSockets.js itself.** The HTTP parser, the TLS and the socket handling are
  [uNetworking's](https://github.com/uNetworking/uWebSockets.js), and a bug in them belongs there.
  Send it to me anyway if you are not sure which side it is on, and I will help work it out.

    **Please check which layer it is before reporting, and report it where it lives.** Serve the same
    request from a bare µWebSockets.js application, with nothing of this project in it:

    ```js
    require("uWebSockets.js")
        .App()
        .any("/*", (res) => res.end("ok"))
        .listen(3000, () => {});
    ```

    If that answers the same way, the bug is in the parser and the fix has to happen at
    [uNetworking/uWebSockets.js](https://github.com/uNetworking/uWebSockets.js/issues), so please open
    it there. The request line, the header block and the chunked framing are all decided before any
    JavaScript of this project runs, and no version of this package can change what they do. What this
    project can answer for is everything after that: routing, the request and response API, the body
    parsers, the static files and the cookies.

- **Express's own behaviour**, when Fulmine reproduces it faithfully. This project's promise is that
  an Express application behaves the same here; where Express is the one that is wrong, the fix
  belongs upstream and this project follows it.
- Anything that needs the attacker to already run code in your process.

## Supported versions

The version on npm is the one that gets fixes. The major number tracks Express rather than semver,
see [Versioning](./README.md#versioning), so 5.x is current for as long as Express 5 is.
