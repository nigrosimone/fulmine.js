---
description: How Fulmine.js is built, where its speed comes from, and the fixes made in Node.js and µWebSockets when the problem was there.
---

# How it's built

**Measured at every layer, fixed where the problem is.**

Most of Fulmine's speed is not ours. [µWebSockets.js](https://github.com/uNetworking/uWebSockets.js) does the network work and matches routes in C++. Fulmine's part is to give it every route it can, and to answer the simple ones without going back to JavaScript. This is where the big numbers on the [performance page](./performance.md) come from.

A request also goes through Node.js, the µWS binding and the µWS server. When a measure found a problem in one of them, we fixed it there, with a pull request and its benchmark. Below there is one fact for each layer, with the link to check it.

## Node.js

- A call from native code into JavaScript (`MakeCallback`, Node-API, `AsyncWrap`) went from 202-208 ns to 155-159 ns. [nodejs/node#66316](https://github.com/nodejs/node/pull/66316), landed on 29 September 2026.
- From Node 24, `AsyncLocalStorage` lost its store in the callbacks of `node::AsyncResource`. Now it keeps it, and the call is 29% to 36% faster. [nodejs/node#66326](https://github.com/nodejs/node/pull/66326), merged on 14 October 2026.

## µWebSockets.js

Fifteen pull requests merged. Some of them:

- `res.onAborted` from 91 ns to 45 ns per call: [#1330](https://github.com/uNetworking/uWebSockets.js/pull/1330), [#1331](https://github.com/uNetworking/uWebSockets.js/pull/1331).
- Strings written as UTF-8 in one pass: a 200 KB ASCII body from 12.0 µs to 6.9 µs. [#1335](https://github.com/uNetworking/uWebSockets.js/pull/1335), [#1337](https://github.com/uNetworking/uWebSockets.js/pull/1337).
- A crash when a string filled the 128 KB pool and the next one was empty, also in v20.71.0. [#1338](https://github.com/uNetworking/uWebSockets.js/pull/1338).
- Every pull request is now benchmarked against its base branch in CI. [#1326](https://github.com/uNetworking/uWebSockets.js/pull/1326).

## µWebSockets

Four fixes to HTTP/1.1 conformance: a `Host` header with a path is refused, a bare LF in the trailers is a 400, a request target that is not visible ASCII is a 400, and `OPTIONS *` is accepted. [#1949](https://github.com/uNetworking/uWebSockets/pull/1949), [#1950](https://github.com/uNetworking/uWebSockets/pull/1950), [#1951](https://github.com/uNetworking/uWebSockets/pull/1951), [#1952](https://github.com/uNetworking/uWebSockets/pull/1952).

µWebSockets and µWebSockets.js are the work of Alex Hultman ([uNetworking](https://github.com/uNetworking)), who reviewed and merged these changes.

## Fulmine

Here is where the multiples are. Routes go to µWS's router and are matched in C++, so the gap with Express grows with the route table instead of shrinking. A handler simple enough is compiled into a µWS declarative response, and µWS answers it without entering JavaScript. Every change on the request path comes with a CPU profile against the commit before it, see [`benchmark/README.md`](https://github.com/nigrosimone/fulmine.js/blob/main/benchmark/README.md).

## Who

Fulmine is maintained by Simone Nigro. The rest of the open source work is on [sndesign.it](https://www.sndesign.it).
