# Changelog

## [5.18.1](https://github.com/nigrosimone/fulmine.js/compare/v5.18.0...v5.18.1) (2026-08-22)

### Performance Improvements

* **request:** a body chunk is copied out of a view of the uWS buffer, not out of a slice of it ([a6d1428](https://github.com/nigrosimone/fulmine.js/commit/a6d14281a14b1da70ade1604d1d262b157943d6a))

## [5.18.0](https://github.com/nigrosimone/fulmine.js/compare/v5.17.0...v5.18.0) (2026-08-22)

### Features

* **compression:** zstd is answered where the client prefers it, ranked below brotli so an upgrade changes nothing ([6db7a81](https://github.com/nigrosimone/fulmine.js/commit/6db7a815bd06e0d90530842d20b291ed3f73b15e))
* **testing:** what one request was made to build, as an assertion and as a Server-Timing field ([a74fc3f](https://github.com/nigrosimone/fulmine.js/commit/a74fc3f285275972f86e562833126f0327b85b97))

### Bug Fixes

* **benchmark:** a scenario can refuse pipelining, which is what the compression row needed to run at all ([bb8add1](https://github.com/nigrosimone/fulmine.js/commit/bb8add111d62e256cd4384520915f756ede1d9dc))
* **errors:** the final handler stays quiet under env test, as express does ([af45745](https://github.com/nigrosimone/fulmine.js/commit/af4574501b7789485fd3ccedc6e01d6901f9b34a))
* **types:** the zstd option carries its own shape, so an older @types/node still compiles ([dffef37](https://github.com/nigrosimone/fulmine.js/commit/dffef37f311664aac9c41c1352aabb1d1777ef5f))

### Performance Improvements

* **compression:** a whole body is gzipped on a kept stream, not on one built and thrown away per call ([6cc3083](https://github.com/nigrosimone/fulmine.js/commit/6cc308309bc76382522fdffc3218f165bce36ada))

## [5.17.0](https://github.com/nigrosimone/fulmine.js/compare/v5.16.0...v5.17.0) (2026-08-20)

### Features

* **benchmark:** --node-options measures a node flag the way --against measures a revision ([d885d5d](https://github.com/nigrosimone/fulmine.js/commit/d885d5daaf27a5291d751c1995b2addef4333e36))

### Bug Fixes

* **response:** an error that ends the response takes it out of the pending list too ([9b91628](https://github.com/nigrosimone/fulmine.js/commit/9b91628457ef4a36abdd97f43c084749d69bc76a))

## [5.16.0](https://github.com/nigrosimone/fulmine.js/compare/v5.15.1...v5.16.0) (2026-08-20)

### Features

* **compression:** the encodings option names what the middleware may answer with ([18720a0](https://github.com/nigrosimone/fulmine.js/commit/18720a0d0f6c5b4b1d27b0a386796f1ec38675a7))

### Bug Fixes

* **benchmark:** a row is marked only when fulmine's own arm moved, not when express wobbled ([af781ea](https://github.com/nigrosimone/fulmine.js/commit/af781eabbd4dca16f7b63d6922cffaf084fc7bcd))

## [5.15.1](https://github.com/nigrosimone/fulmine.js/compare/v5.15.0...v5.15.1) (2026-08-19)

### Bug Fixes

* **router:** a req.url rewrite inside a prefix mount restores as express does, and the 404 prints originalUrl ([4c76047](https://github.com/nigrosimone/fulmine.js/commit/4c760475737f4cbe5a3edc38a792b668634c28e8))
* **router:** a rewrite that falls out of a mount that consumed the whole path rejoins as express does ([4e27339](https://github.com/nigrosimone/fulmine.js/commit/4e273394d9d75bf11732584407ce5e6a577945a1))
* **router:** the slashAdded mangle belongs to the mount that consumed a prefix, not to a pathless use inside it ([38458de](https://github.com/nigrosimone/fulmine.js/commit/38458ded46a737226f13ec26c324e376f3a55d85))

### Performance Improvements

* **middlewares,response:** the context bind drops node's wrapper, and constant headers stop re-proving themselves ([86af580](https://github.com/nigrosimone/fulmine.js/commit/86af5804ccab87c4827d345b08b54793de7544b9))
* **request,response:** the second req.query read replays the first parse, and the hot path drops dead reads ([deca0d2](https://github.com/nigrosimone/fulmine.js/commit/deca0d2c1b67c47bcba436aa5dbeff57eb1d8f81))
* **router:** the generic scan asks an index for its literal routes, and the hop pays only for what it uses ([4164ca3](https://github.com/nigrosimone/fulmine.js/commit/4164ca3adcb115dfac40347eca4d91da4bf6a00b))

## [5.15.0](https://github.com/nigrosimone/fulmine.js/compare/v5.14.0...v5.15.0) (2026-08-19)

### Features

* **types:** the http.Server surface of the application is declared, close() and address() included ([9af558f](https://github.com/nigrosimone/fulmine.js/commit/9af558f20e5c72f6932e1ff70233ab1a99d4ab4f))

## [5.14.0](https://github.com/nigrosimone/fulmine.js/compare/v5.13.3...v5.14.0) (2026-08-19)

### Features

* **types:** res.aborted is declared, and a ws handler may narrow the request it was given ([5233343](https://github.com/nigrosimone/fulmine.js/commit/5233343d0ba51410cef210426fa174aa297f9d2c))
* **types:** the application, the socket and the behaviour of ws() are importable by name ([3c919e1](https://github.com/nigrosimone/fulmine.js/commit/3c919e1ae1b2f718ae4480a957433f80f3e055be))

### Bug Fixes

* **body:** the parser errors carry the name and the class http-errors gives them ([2adbb23](https://github.com/nigrosimone/fulmine.js/commit/2adbb23389ab47e4b6803b7930c73719e7803940))
* **types:** the ws handlers keep uWS's own return types, so an async open or message is not an error ([510e868](https://github.com/nigrosimone/fulmine.js/commit/510e8685d04aa2f86afb04ba5db1384b37b3c151))
* **websocket:** an upgrade whose client left sees res.aborted while it is still awaiting ([9bfcd06](https://github.com/nigrosimone/fulmine.js/commit/9bfcd06c3f2bf6be2f08becfe1602c065a4fb48f))

## [5.13.3](https://github.com/nigrosimone/fulmine.js/compare/v5.13.2...v5.13.3) (2026-08-18)

### Bug Fixes

* **request:** refuse a target node refuses, chunked twice, and close the connection a list asked to close ([7a13f5e](https://github.com/nigrosimone/fulmine.js/commit/7a13f5ea32d84ae551de51b36d450c8110393eb7))
* **router:** req.route is the route's own, with the verbs and the layers express puts on it ([a9bedc9](https://github.com/nigrosimone/fulmine.js/commit/a9bedc9cb54b9a566df064ed489a7cd01c6351c3))

## [5.13.2](https://github.com/nigrosimone/fulmine.js/compare/v5.13.1...v5.13.2) (2026-08-18)

### Bug Fixes

* **benchmark:** alternate the arms in warmed rounds and divide a small table-wide shift out of the marking ([e8dc53e](https://github.com/nigrosimone/fulmine.js/commit/e8dc53e176df420c6ba3e335b2509000ac7180db))
* **router:** route on a rewritten req.method, and drop the slash a RegExp mount took from baseUrl ([a8a9b94](https://github.com/nigrosimone/fulmine.js/commit/a8a9b94c6bed57e9f035f89c2d5240291b93ca83))
* **static:** look for the index inside what a trailing slash asked for, and take a list of names ([49ff15d](https://github.com/nigrosimone/fulmine.js/commit/49ff15d9d0d466eedeb7ed8e47a32fdb47980769))

## [5.13.1](https://github.com/nigrosimone/fulmine.js/compare/v5.13.0...v5.13.1) (2026-08-17)

### Bug Fixes

* **response:** the response is destroyed when the client hangs up, so res.on(close) runs ([#15](https://github.com/nigrosimone/fulmine.js/issues/15)) ([5f5fc98](https://github.com/nigrosimone/fulmine.js/commit/5f5fc98a36aae3e7b3ba7cb4a852619a10c6ddbe))

## [5.13.0](https://github.com/nigrosimone/fulmine.js/compare/v5.12.3...v5.13.0) (2026-08-17)

### Features

* **nest:** the express adapter ships as fulmine.js/nest, so a Nest application needs no adapter of its own ([#13](https://github.com/nigrosimone/fulmine.js/pull/13))
* **cli:** override writes the package manager substitution for a framework that requires express in its own code ([#13](https://github.com/nigrosimone/fulmine.js/pull/13))
* **cli:** angular declares this package external in angular.json's server build ([#13](https://github.com/nigrosimone/fulmine.js/pull/13))

### Bug Fixes

* **body:** req.body reaches a request only once a parser has run, as it does on express ([#13](https://github.com/nigrosimone/fulmine.js/pull/13))
* **response:** writeHead sets headers node's way, without the charset res.set adds ([#13](https://github.com/nigrosimone/fulmine.js/pull/13))

Both fixes were found by a new comparison suite that serves the same application on Express and on
this through Nest, Next, Astro, SvelteKit, React Router, Apollo and tRPC. `req.body` being on every
request broke every tRPC mutation, and missing where Express has one is a 500 from Apollo;
`writeHead` adding a charset changed every page Astro and SvelteKit rendered.

## [5.12.3](https://github.com/nigrosimone/fulmine.js/compare/v5.12.2...v5.12.3) (2026-08-17)

### Bug Fixes

* **declarative:** a status that carries no content is not compiled, its body desynced the connection ([dd501ba](https://github.com/nigrosimone/fulmine.js/commit/dd501ba4852b0b26e2b44d2ec5e8a63971fa06f3))
* **deps:** the cookie package express depends on, whose message for an invalid name has no value in it ([f0634c0](https://github.com/nigrosimone/fulmine.js/commit/f0634c052aacf59b2f71ea05e874b53b2720e49a))
* **request:** refuse a method nobody defines, an overflowing length and a transfer-encoding not ending in chunked ([b23ab32](https://github.com/nigrosimone/fulmine.js/commit/b23ab32c41bc5025dc6a1e4de2641787988241bd))
* **request:** req.path follows a req.url a middleware assigned, as express reads it ([af29105](https://github.com/nigrosimone/fulmine.js/commit/af29105a86b2c35a813ef28b8086765eaa060184))
* **router:** a route answering the mount point itself keeps the mount off the native path ([9d77c95](https://github.com/nigrosimone/fulmine.js/commit/9d77c95c0742cf5e1ece2d207f5b19538faf3714))
* **router:** a route that captures cannot answer declaratively, nothing decodes its value ([713ab85](https://github.com/nigrosimone/fulmine.js/commit/713ab8536914bb8474163f0400775079b4ebd1a8))
* **router:** an earlier route matching only the trailing slash keeps its leaf off the native path ([b835ee2](https://github.com/nigrosimone/fulmine.js/commit/b835ee2904f863101c67c916b15480d35f53fbfa))
* **router:** step over a mount while an error is in flight, as express does ([20ba0e6](https://github.com/nigrosimone/fulmine.js/commit/20ba0e61b7f6a69b52d3d78f0752ae4485229644))
* **router:** the whole text between a parameter and the one in the group after it is the separator ([9596f3e](https://github.com/nigrosimone/fulmine.js/commit/9596f3e4898f6171ab4209e73933b7ef14a01922))

## [5.12.2](https://github.com/nigrosimone/fulmine.js/compare/v5.12.1...v5.12.2) (2026-08-16)

### Bug Fixes

* **response:** put node's error code in the stack line of a refused header, as node does ([f984da0](https://github.com/nigrosimone/fulmine.js/commit/f984da0186baf1d1378276e7b013461ecf4988be))
* **router:** an automatic OPTIONS reply no longer runs the param callbacks of the routes it counted ([2f7f2ae](https://github.com/nigrosimone/fulmine.js/commit/2f7f2ae1707a3b82f972ce38d1ac78070f52aa15))
* **router:** carry an OPTIONS error to the handlers, and enter a route on HEAD for its param callbacks ([fa1700f](https://github.com/nigrosimone/fulmine.js/commit/fa1700f4d11d699436e93fcaff4b7c73bffa85d8))
* **router:** read a wildcard or an optional group as more than its text when judging overlap ([43c010e](https://github.com/nigrosimone/fulmine.js/commit/43c010e253eefc451ce6f21462e087ebb56bf413))
* **router:** run a router's param callbacks only for the parameters its own pattern captured ([e82976e](https://github.com/nigrosimone/fulmine.js/commit/e82976e4e1d6ce4f22a0d39d89a5f37034e1a81a))

## [5.12.1](https://github.com/nigrosimone/fulmine.js/compare/v5.12.0...v5.12.1) (2026-08-16)

### Bug Fixes

* **benchmark:** judge a row against its recent band, not the single last run, and never flag a bound row ([d114f20](https://github.com/nigrosimone/fulmine.js/commit/d114f20b3b417269dd196fa5568bfdc7b117d0a8))
* **request:** refuse a request whose content-length uWS and the wire disagree on ([b687427](https://github.com/nigrosimone/fulmine.js/commit/b68742711c1f03571b2a3271c4a91846ccd5669f))

## [5.12.0](https://github.com/nigrosimone/fulmine.js/compare/v5.11.1...v5.12.0) (2026-08-16)

### Features

* an etag methods setting limits the generated ETag to the methods it names, closes [#10](https://github.com/nigrosimone/fulmine.js/issues/10) ([5d2ed7a](https://github.com/nigrosimone/fulmine.js/commit/5d2ed7a53277a11d37a0ab492f938d4538b16279))

### Bug Fixes

* **application:** close() drops idle keep-alive connections, so a drain cannot be held open by them ([f6bf911](https://github.com/nigrosimone/fulmine.js/commit/f6bf9114e31d705f2efab80dbc7aa8dc4e85c360))
* **benchmark:** a canary request before the load, a stray server can share the port on Windows ([f5b91fc](https://github.com/nigrosimone/fulmine.js/commit/f5b91fcbbb361bf54f5e7b18b02f0e6a7194300a))
* **benchmark:** weigh samples by their own timeDeltas and print the idle share, closes [#8](https://github.com/nigrosimone/fulmine.js/issues/8) ([d54e533](https://github.com/nigrosimone/fulmine.js/commit/d54e533cccfd8e8c62008619cba53dfe050ea987))
* **cli:** end the file reading threads that loading an application started, so profile leaves none behind ([389e68a](https://github.com/nigrosimone/fulmine.js/commit/389e68a67950b286aca60be1aaf5cb78617776fe))
* **declarative:** do not compile a response carrying a validator uWS could never honour ([50a0976](https://github.com/nigrosimone/fulmine.js/commit/50a09761c5720e8205ded5a7302224d4952eda83))
* **declarative:** lowercase compiled header names and document the Connection divergence, closes [#7](https://github.com/nigrosimone/fulmine.js/issues/7) ([e2ef278](https://github.com/nigrosimone/fulmine.js/commit/e2ef27852eabc6dbb1c32c9d925bb90d705684b4))
* **response:** getHeaders() answers a shallow copy on a null prototype, as node does, closes [#6](https://github.com/nigrosimone/fulmine.js/issues/6) ([8ed53c6](https://github.com/nigrosimone/fulmine.js/commit/8ed53c62c53b12de22204f1805d0ddbcdd4fa46b))
* **response:** refuse a header name or value that would split the response, as node does ([d3fd6a7](https://github.com/nigrosimone/fulmine.js/commit/d3fd6a70a720e3758fef96738edafe08a32a9feb))
* **router:** a literal route in a mounted router must not take the native path when a later route could answer it ([2d60954](https://github.com/nigrosimone/fulmine.js/commit/2d60954b01fea558adb3782533977eac3b916113))

### Performance Improvements

* ask node for the compile cache at startup ([c523d68](https://github.com/nigrosimone/fulmine.js/commit/c523d6817253e3542206a287bc54acbf70801a7a))
* **middlewares:** a chunked body is collected natively too, one crossing instead of one per chunk ([0dbc422](https://github.com/nigrosimone/fulmine.js/commit/0dbc422c9567db6876ba1cadd9f2fd32e7bbdedb))
* read the hot-path settings as fields, and hand uWS the whole response head in one call ([6ae877c](https://github.com/nigrosimone/fulmine.js/commit/6ae877cbeab294e6b35667c81d4206ce3ed54d7f))
* **router:** fold patterns at registration and the path once per rewrite in the fallback scan ([9eb962b](https://github.com/nigrosimone/fulmine.js/commit/9eb962b65ff577eca239dc0f569da55935d56e8a))
* **router:** freeze flags once per scan, arm onAborted on the generic path only when pending ([5edb701](https://github.com/nigrosimone/fulmine.js/commit/5edb7011e9c2acdc9669c1dda728cbede5503e71))
* **router:** the header skip no longer asks for etag to be off ([5df606b](https://github.com/nigrosimone/fulmine.js/commit/5df606b6ec01531605ed989ed55b2b9b57f0ad9f))

### Reverts

* **application:** drop the idle close, a held uWS wrapper is a use after free once its socket went ([1f1d9b5](https://github.com/nigrosimone/fulmine.js/commit/1f1d9b55ada83420b4719bc05b90f84e0a597834))
* **response:** one writeHeader per header again, packing measured no better ([#11](https://github.com/nigrosimone/fulmine.js/issues/11)) ([02c7a8d](https://github.com/nigrosimone/fulmine.js/commit/02c7a8d19ccc5752f4779e0a3bb0d91ffe651e83))

## [5.11.1](https://github.com/nigrosimone/fulmine.js/compare/v5.11.0...v5.11.1) (2026-08-14)

### Bug Fixes

* **cli:** one bin named fulmine, so npx runs the command on windows too ([50816ce](https://github.com/nigrosimone/fulmine.js/commit/50816ce3d147f1411fdb218a43a99a1ea2105383))

## [5.11.0](https://github.com/nigrosimone/fulmine.js/compare/v5.10.0...v5.11.0) (2026-08-14)

### Features

* **settings:** connection headers, off it advertises neither and only a closing connection says so ([185bb8c](https://github.com/nigrosimone/fulmine.js/commit/185bb8c273b140f36d420a96bcca5d21106fb869))
* **settings:** stat cache, a window in which a file's size and mtime are remembered ([73b0b40](https://github.com/nigrosimone/fulmine.js/commit/73b0b4082698532c12e052a0bd59d999351e5847))

### Performance Improvements

* **declarative:** a literal body goes out in one end(), so a compiled route carries a Content-Length ([ac81a4d](https://github.com/nigrosimone/fulmine.js/commit/ac81a4d5ef3d12bbbb0ac52d701c45fec5fbb696))
* **declarative:** res.type() and res.set(object) compile, so a handler that names its media type stays native ([5240612](https://github.com/nigrosimone/fulmine.js/commit/52406120508f6c7d9e930a8a16e713e3d284cba2))

## [5.10.0](https://github.com/nigrosimone/fulmine.js/compare/v5.9.0...v5.10.0) (2026-08-13)

### Features

* **benchmark:** a trophy for a ratio that rose, eyes only for one that fell ([f9747dc](https://github.com/nigrosimone/fulmine.js/commit/f9747dcf9e4d53811656ddb16c571ac0d09a4938))
* **types:** express.serverTiming, and the timing marks it hangs on the response ([b00ed52](https://github.com/nigrosimone/fulmine.js/commit/b00ed521a485a907e97e42b9b969f2b764f37c9c))

### Bug Fixes

* **cli:** profile stubs every copy of the library the application could load, and reads the start script ([cdb05c7](https://github.com/nigrosimone/fulmine.js/commit/cdb05c7a33929e28745f390126ea76683f38af69))

## [5.9.0](https://github.com/nigrosimone/fulmine.js/compare/v5.8.0...v5.9.0) (2026-08-13)

### Features

* express({ cluster: "auto" }) forks one worker per core on the same port ([edf4037](https://github.com/nigrosimone/fulmine.js/commit/edf4037639cd87f81276a40c9bbd9939a7e970c1))

### Bug Fixes

* **static:** drop the trailing separator join keeps, so a file as root is served on linux ([d19e4ea](https://github.com/nigrosimone/fulmine.js/commit/d19e4eaa45d6a5849e9b773c9dc2a80bfa034e32))
* **verify:** read the glibc outside checkLibc, so undefined still means musl ([8c5e759](https://github.com/nigrosimone/fulmine.js/commit/8c5e759b2454f8d301a0a0ca0d5b63ca15e40066))

### Performance Improvements

* **static:** resolve the root once and keep the traversal check on the joined path ([dbfe60b](https://github.com/nigrosimone/fulmine.js/commit/dbfe60b7daab2accbd718b486939496cc6075e3d))

## [5.8.0](https://github.com/nigrosimone/fulmine.js/compare/v5.7.0...v5.8.0) (2026-08-12)

### Features

* an application answers as an http.Server ([56def4d](https://github.com/nigrosimone/fulmine.js/commit/56def4d6033cecb7ae1263f79189b8b1cedaea68))
* **cli:** verify checks the machine and the image, explain reads one route ([1d90a9a](https://github.com/nigrosimone/fulmine.js/commit/1d90a9a316ecbc30cf70c7543bfb787db1f86494))
* express.serverTiming() reports how the request was routed ([92c667e](https://github.com/nigrosimone/fulmine.js/commit/92c667eef964b1b4b686a921cc4a66c942390ae3))
* express.testing asserts what listen() decided about a route ([70b69ba](https://github.com/nigrosimone/fulmine.js/commit/70b69bad342a680b0c4fadeac7671281d73ed7fb))

## [5.7.0](https://github.com/nigrosimone/fulmine.js/compare/v5.6.0...v5.7.0) (2026-08-12)

### Bug Fixes

* a wildcard followed by an optional group left the group empty ([f182812](https://github.com/nigrosimone/fulmine.js/commit/f1828127a6f0921a07816c238ff42835ca2720ac))

### Performance Improvements

* compression skips the response wrapping when nothing can be compressed ([f7caeb0](https://github.com/nigrosimone/fulmine.js/commit/f7caeb0d2753a216860b25cff60821888379a301))
* preCompressed costs one stat per request instead of three ([549f2f9](https://github.com/nigrosimone/fulmine.js/commit/549f2f9126a02485591bcaacf1044ab5147efadf))

## [5.6.0](https://github.com/nigrosimone/fulmine.js/compare/v5.5.2...v5.6.0) (2026-08-12)

### Features

* **cli:** migrate names the modules with a faster built-in ([898f660](https://github.com/nigrosimone/fulmine.js/commit/898f660ae1dfc1457b2ad55daefacfd382a01dad))
* express.compression(), the compression module's middleware built in ([2384faa](https://github.com/nigrosimone/fulmine.js/commit/2384faa7377b0a83ed06367bb6488a25254921ae))
* express.static() serves the .br and .gz twins with preCompressed ([082f376](https://github.com/nigrosimone/fulmine.js/commit/082f37642e6367827623c9e8f92d2d0d03417da3))

### Bug Fixes

* res.end(null) left the response unfinished ([19b596a](https://github.com/nigrosimone/fulmine.js/commit/19b596a3a4815b42d1061c49fa46197d085bdade))

## [5.5.2](https://github.com/nigrosimone/fulmine.js/compare/v5.5.1...v5.5.2) (2026-08-11)

### Performance Improvements

* a mounted application is recognised by its field, not by its constructor name ([9c2494d](https://github.com/nigrosimone/fulmine.js/commit/9c2494d9ea3e69364d8b85ab31f10f0a0280e7ba))
* a response builds its chunk queue and its flush closure only when it streams ([7650293](https://github.com/nigrosimone/fulmine.js/commit/765029381662047c04496107f65a96334d7876d5))
* a use with no path answers its mount prefix without running a regex ([ddc6bb3](https://github.com/nigrosimone/fulmine.js/commit/ddc6bb3aa0e060420e3196e2fa90aac836d379e3))
* the etag hashes a string body instead of copying it into a buffer first ([306d739](https://github.com/nigrosimone/fulmine.js/commit/306d739749de7702e620deaecce86691c197413b))
* the generic handler walks without the promise pair nobody awaited ([2b2dbc4](https://github.com/nigrosimone/fulmine.js/commit/2b2dbc4743943b1cda0dcad5b1706aecb14c1a8b))

## [5.5.1](https://github.com/nigrosimone/fulmine.js/compare/v5.5.0...v5.5.1) (2026-08-08)

### Bug Fixes

* the response and request members node has that we did not ([f446342](https://github.com/nigrosimone/fulmine.js/commit/f446342751891859e3997e8b418d44280fb7e6dc))

### Performance Improvements

* a chunked body is gathered before it reaches uWS ([1e1f2b3](https://github.com/nigrosimone/fulmine.js/commit/1e1f2b33fadd8ccce2340362bfdb13b34cb5d138))

## [5.5.0](https://github.com/nigrosimone/fulmine.js/compare/v5.4.1...v5.5.0) (2026-08-08)

### Features

* res.flushHeaders, and the types stop lying about the app and about listen ([eb35d95](https://github.com/nigrosimone/fulmine.js/commit/eb35d95ea5f27f4f86f1e7f693b2dfea2d5ac0e6))

## [5.4.1](https://github.com/nigrosimone/fulmine.js/compare/v5.4.0...v5.4.1) (2026-08-08)

### Performance Improvements

* req.query hands out a fresh parse instead of a copy of a cached one ([3d72875](https://github.com/nigrosimone/fulmine.js/commit/3d72875d4fbdce371749141812198dc13447b6d0))

## [5.4.0](https://github.com/nigrosimone/fulmine.js/compare/v5.3.0...v5.4.0) (2026-08-07)

### Features

* **demo:** the demo reports Server-Timing, and the page shows what the server measured ([9fb663f](https://github.com/nigrosimone/fulmine.js/commit/9fb663f9e2c9b66033e3c04ae6efe4eb2c68f553))
* req.ip can come from a PROXY protocol preamble, when the application asks for it ([474ef52](https://github.com/nigrosimone/fulmine.js/commit/474ef528f58c0e2eb3c14a857968109d591febc8))

### Bug Fixes

* a 406 from res.format leaves the route, as express's does ([6abd2f1](https://github.com/nigrosimone/fulmine.js/commit/6abd2f1ffa58746b601c4efd57985e0d27d53a4a))
* a mount does not answer past a layer that was written before it and reaches inside ([8c8252d](https://github.com/nigrosimone/fulmine.js/commit/8c8252d9eb326edd38fcf7529fba07e0dace615a))
* the demo deploy changes directory instead of passing a config path fly resolves twice ([9593cfd](https://github.com/nigrosimone/fulmine.js/commit/9593cfdbf7ce0c0d416040ce7f5ddb0e2adc2942))
* the window that reads the peer address up front closes once instead of reopening every 100000 requests ([4d17252](https://github.com/nigrosimone/fulmine.js/commit/4d172529a1b0d165db21ccb06f3fe2da20787df3))

### Performance Improvements

* the response says Writable and does not build one until something asks ([6944807](https://github.com/nigrosimone/fulmine.js/commit/694480769ae263a18297c24277db7d78d551ad74))

## [5.3.0](https://github.com/nigrosimone/fulmine.js/compare/v5.2.0...v5.3.0) (2026-08-07)

### Features

* a demo that shows a fulmine app is an express app, deployed on fly ([e1b3d61](https://github.com/nigrosimone/fulmine.js/commit/e1b3d61f6724338c500958b1a2aa8dc51aa620cf))
* npx fulmine profile prints what listen worked out about each route ([5678ff4](https://github.com/nigrosimone/fulmine.js/commit/5678ff4015ce04b8ff6c386e67da320eceac7d87))

### Bug Fixes

* a case variant asked for with a trailing slash still finds the literal route ([dd4ea01](https://github.com/nigrosimone/fulmine.js/commit/dd4ea012d69c18fee0dc3f244ceaa43e1bc6b1e7))
* a case variant of a literal route leaves the native fast path ([df466b5](https://github.com/nigrosimone/fulmine.js/commit/df466b579c80f66da4b69d7e68e0e4aad4e5b1e5))
* a file that cannot be served reports past the route, as express does ([d8d14db](https://github.com/nigrosimone/fulmine.js/commit/d8d14db08447ebcfa2c888a8393f88c601c0ff6e))
* a later literal route yields to an earlier one that answers the slashed path ([5c90c0e](https://github.com/nigrosimone/fulmine.js/commit/5c90c0ee41d196ef09ff6cd705175aa2ee144ec8))
* a literal route wins over a later param route in any case ([75c6430](https://github.com/nigrosimone/fulmine.js/commit/75c6430c93826895d2fc810c85c2c5dd05a5312f))
* a mount reached in another case still hands over its parameters ([c11d4ac](https://github.com/nigrosimone/fulmine.js/commit/c11d4acfc05554bff93b5ba20a41b213e98b871a))
* a param that will not decode answers 400 whatever the method ([151b82a](https://github.com/nigrosimone/fulmine.js/commit/151b82a5c975800470503303e41665656fc65645))
* a parameter name may carry accents, and may be written twice ([a6174aa](https://github.com/nigrosimone/fulmine.js/commit/a6174aa704380387702a210f2616090965f295ea))
* a route before a mount keeps its turn even when its method differs ([2418c1f](https://github.com/nigrosimone/fulmine.js/commit/2418c1fc674998f2571afef3300c044048b9e638))
* a route written with trailing slashes is registered without them ([ebdcaaa](https://github.com/nigrosimone/fulmine.js/commit/ebdcaaa15a4c98d5958533ceb3eda22d5f5f6cac))
* a route's error handler catches only what that route raised ([338f663](https://github.com/nigrosimone/fulmine.js/commit/338f6634270473771f6171696eacda3218b626bf))
* a second wildcard in a path is held to one segment, as express holds it ([4b200f2](https://github.com/nigrosimone/fulmine.js/commit/4b200f26421d1cd2ed0535cb2751f5ed7bca4eb0))
* a segment shared by two captures is divided as express divides it ([6e9f7f0](https://github.com/nigrosimone/fulmine.js/commit/6e9f7f0d49e982469071b489c0718de8cda7f201))
* a view that will not render reports past the route, and views keeps the path it was given ([89fe63e](https://github.com/nigrosimone/fulmine.js/commit/89fe63e6bf4db2413c7d471e20a1ba14b7e7211b))
* an encoded slash does not make a path a directory request ([fd3d8c2](https://github.com/nigrosimone/fulmine.js/commit/fd3d8c28fe3bb1b47aa2fc5903308c5f9ac31f45))
* express.static names the file send would have named ([9caafdc](https://github.com/nigrosimone/fulmine.js/commit/9caafdcb2fad1924141fb4284664fefadaf90989))
* handing back from a sub-app restores the app that was current, not its parent ([b2fe3ac](https://github.com/nigrosimone/fulmine.js/commit/b2fe3ac455754b4dadd6afe84358de5ca305b9a4))
* mounted routers, enabled(), and a lone "?" answer as express does ([a35e967](https://github.com/nigrosimone/fulmine.js/commit/a35e96729682230fe15dd14e594b0aa44dd9c733))
* mounts count what they took, and a NUL in a static path is a bad request ([b9ad4d8](https://github.com/nigrosimone/fulmine.js/commit/b9ad4d80526d5fade10318e69c1b70faef20062f))
* only an application takes req.app back when a sub-app hands over ([a1cc927](https://github.com/nigrosimone/fulmine.js/commit/a1cc9276adfb2585c46c2392ed268e7d93daad14))
* static stats the path it resolved, which is what linux and windows agree on ([ab77728](https://github.com/nigrosimone/fulmine.js/commit/ab77728ee42942381904f36fbba3ca60c38e6aa2))
* static stats the path send stats, and a sub-app renders with its parent's engine ([b55ee2e](https://github.com/nigrosimone/fulmine.js/commit/b55ee2ec08c3408d4c68e62f00f2aecaee4f043b))
* the default error page escapes what it prints ([e3e3185](https://github.com/nigrosimone/fulmine.js/commit/e3e31854674b219a55d9a3700eaa23014d406a25))
* the extended query parser answers what qs answers ([2a866c3](https://github.com/nigrosimone/fulmine.js/commit/2a866c3a27bb4134d32ec9a409477ec5ea39b75e))
* the first error wins, so a decode failure does not replace what a middleware refused ([7b13c05](https://github.com/nigrosimone/fulmine.js/commit/7b13c054f53d62fc0765b986a414545d9907bf5c))
* the OPTIONS reply lists the answering router's own verbs ([b3c98c7](https://github.com/nigrosimone/fulmine.js/commit/b3c98c7ebe28394eaaea97d92be03d8a9e0d2da7))
* the pattern allows the trailing slash instead of the path losing it ([759d69f](https://github.com/nigrosimone/fulmine.js/commit/759d69fbdae3600f84463314380c8fd93b68fe04))

### Performance Improvements

* a chain steps over a body parser the request gets nothing out of ([e5e48f2](https://github.com/nigrosimone/fulmine.js/commit/e5e48f2690e3133467caf693d6aaedc8aa38d3be))
* a mapped IPv4 peer is read straight out of the bytes ([537be62](https://github.com/nigrosimone/fulmine.js/commit/537be62147045898ba3606735606b915ca202901))
* the request declares the six fields that were appearing on it after construction ([5c7a3d7](https://github.com/nigrosimone/fulmine.js/commit/5c7a3d797013c0c52f9ccef538033710ff380945))
* the request says Readable and builds one only when something asks ([8981e93](https://github.com/nigrosimone/fulmine.js/commit/8981e932565c867f2f7eaf5814c55935916cc40e))
* the response arms its two listeners by writing the map on() would have written ([87b5ce5](https://github.com/nigrosimone/fulmine.js/commit/87b5ce5663b8ebca55651c30e8b42956eeec9424))

## [5.2.0](https://github.com/nigrosimone/fulmine.js/compare/v5.1.9...v5.2.0) (2026-08-06)

### Features

* app.ws() serves websockets first class, with an upgrade hook and the request on the socket ([fa53c3f](https://github.com/nigrosimone/fulmine.js/commit/fa53c3fe8592a5de10afbe95b943403b1da45dee))

### Performance Improvements

* the request declares next and the response links its request in the constructor ([7d981b9](https://github.com/nigrosimone/fulmine.js/commit/7d981b9ad9651e7194b77bc66bec8f9bd4464ce8))

## [5.1.9](https://github.com/nigrosimone/fulmine.js/compare/v5.1.8...v5.1.9) (2026-08-05)

### Bug Fixes

* a handler that never sends no longer compiles into an empty 200 ([aa900df](https://github.com/nigrosimone/fulmine.js/commit/aa900dfc554bff1916a8b94c8c64dddf97e50549))
* asking for http3 throws the clear error a broken uWS build deserves, with a canary for the day it works ([b7f9859](https://github.com/nigrosimone/fulmine.js/commit/b7f985959de8e2e6bc96210b45d3bb7049a1ea73))

## [5.1.8](https://github.com/nigrosimone/fulmine.js/compare/v5.1.7...v5.1.8) (2026-08-05)

### Bug Fixes

* writing req.url disqualifies a skip chain, and a chain reading no query skips the fetch ([3069647](https://github.com/nigrosimone/fulmine.js/commit/3069647c01babf0332d775afe8f0237208a853c9))

## [5.1.7](https://github.com/nigrosimone/fulmine.js/compare/v5.1.6...v5.1.7) (2026-08-05)

### Performance Improvements

* a route whose chain provably reads no header skips the header copy ([e117ac2](https://github.com/nigrosimone/fulmine.js/commit/e117ac2d103021a0b9188c2df7431ca36c6c3373))
* the header skip reaches parameterised native routes on a holder of its own ([9360ec5](https://github.com/nigrosimone/fulmine.js/commit/9360ec546f190f73f15a7215a7506fd4b27f272c))

## [5.1.6](https://github.com/nigrosimone/fulmine.js/compare/v5.1.4...v5.1.6) (2026-08-05)

### Bug Fixes

* keepsBuffer is optional, tsc read it as required after an optional ([9931828](https://github.com/nigrosimone/fulmine.js/commit/9931828624674e57781f1efdd65bde0defe06d37))

### Performance Improvements

* body parsers read headers raw, bind late, and collect the body natively ([63641f1](https://github.com/nigrosimone/fulmine.js/commit/63641f1e6802911eeaca0c087e84f4a0c72a8eeb))
* express.static binds only sendFile's completion, the synchronous exits stay unbound ([462bd87](https://github.com/nigrosimone/fulmine.js/commit/462bd875bfb7b594ff772fcb4e7206772a06b0dc))

## [5.1.4](https://github.com/nigrosimone/fulmine.js/compare/v5.1.3...v5.1.4) (2026-08-05)

### Performance Improvements

* the query parser answers on a bare null prototype and uWS only hears about aborts that can still happen ([6420232](https://github.com/nigrosimone/fulmine.js/commit/64202320468cca2b1979747b7a2a73295295c71f))

## [5.1.3](https://github.com/nigrosimone/fulmine.js/compare/v5.1.2...v5.1.3) (2026-08-04)

### Performance Improvements

* sendFile answers unchanged small files from a stat-validated cache, and the pending set becomes an intrusive list ([72c0708](https://github.com/nigrosimone/fulmine.js/commit/72c07081b2ce023d1ff4ca8cadaeaf0c8f0e8b82))

## [5.1.2](https://github.com/nigrosimone/fulmine.js/compare/v5.1.1...v5.1.2) (2026-08-04)

### Performance Improvements

* a bodyless request ends its stream only when someone reads it ([5fee6c3](https://github.com/nigrosimone/fulmine.js/commit/5fee6c3e8fb08511a3509cde11aa09b0424b6569))
* a literal native route hands the request its path and method as constants ([d839128](https://github.com/nigrosimone/fulmine.js/commit/d83912888d3aa7cfe8e0d87c36c98a0115e9b1af))
* bodies subscribe on header evidence, Buffers reach uWS uncopied ([29fc7f4](https://github.com/nigrosimone/fulmine.js/commit/29fc7f4f594b0ae38bdb9b370358c79016f30d60))

## [5.1.1](https://github.com/nigrosimone/fulmine.js/compare/v5.1.0...v5.1.1) (2026-08-04)

### Performance Improvements

* no cork inside uWS's own cork, no status line uWS writes itself ([fe23fee](https://github.com/nigrosimone/fulmine.js/commit/fe23fee2ea5f13fbf248fff01c80dab5cd7db167))

## [5.1.0](https://github.com/nigrosimone/fulmine.js/compare/v5.0.0...v5.1.0) (2026-08-04)

### Features

* case-insensitive routing by default, as in Express 5 ([8c95b9d](https://github.com/nigrosimone/fulmine.js/commit/8c95b9d8512196e2b27d4d90136d4aa16ec1e534))
* express.Route, and a router drives a plain request object ([851b0c3](https://github.com/nigrosimone/fulmine.js/commit/851b0c3e8dc155272fee15b56ff2cd26dc7615d5))

### Bug Fixes

* a pathless mount keeps the chain in front of it ([b3cf706](https://github.com/nigrosimone/fulmine.js/commit/b3cf706bc9d8101c9ba54a570468bf23f425f8c4))
* a RegExp route matches and captures the way express matches it ([6a2702e](https://github.com/nigrosimone/fulmine.js/commit/6a2702e7142ab7879d3e61107127c80b35fdaded))
* the express suite's own failures go to zero ([76416d0](https://github.com/nigrosimone/fulmine.js/commit/76416d0bcf9d9cf579cdd6296846f3be627cf7f4))

### Performance Improvements

* a request allocates a dozen fewer objects on its way through ([a3a0b42](https://github.com/nigrosimone/fulmine.js/commit/a3a0b42bc7154fef6325f1d7dd63c4e7fc7d9bc8))
* the native handler walks without a promise nobody awaited ([6aa4fe7](https://github.com/nigrosimone/fulmine.js/commit/6aa4fe7930bf4bc29a10e84364c1a1e8c86a9b9d))

## [5.0.0](https://github.com/nigrosimone/fulmine.js/compare/v5.0.0-rc.1...v5.0.0) (2026-08-03)

### Features

* assigning req.url in middleware re-routes the rest of the stack ([b8f1f16](https://github.com/nigrosimone/fulmine.js/commit/b8f1f162a84846136c8233ace7b0d040a27aa24c))

### Bug Fixes

* a views list is searched in order, and render() locals win ([2faa25e](https://github.com/nigrosimone/fulmine.js/commit/2faa25e674021e40eba2dd5d3f19491467c4ebc7))
* app.param callbacks run once per value, as express does ([2aa369f](https://github.com/nigrosimone/fulmine.js/commit/2aa369fea29ec59d7b74dca30e1a067987e0c37f))
* app.use refuses a handler that is not a function ([291fe9b](https://github.com/nigrosimone/fulmine.js/commit/291fe9b28055fa2cef4e456a3dc15b2b8c4535a8))
* close() drains in-flight requests, and the app edges the review found ([8b7e2f8](https://github.com/nigrosimone/fulmine.js/commit/8b7e2f8d7d28b6447d641fbef5d8dbd3f9bb7abb))
* express.static checks its arguments and answers the methods it serves ([f942633](https://github.com/nigrosimone/fulmine.js/commit/f942633a4ed0b0867f2b8c7bfd5aff4561fc09bb))
* res.format with no match raises the 406 for the error handler ([adf715a](https://github.com/nigrosimone/fulmine.js/commit/adf715a72dfa44cd5dcefe9a094776d80333edd7))
* sendFile survives read errors and aborts, and five response edges ([b52d9b4](https://github.com/nigrosimone/fulmine.js/commit/b52d9b442798c9929310f0b2f5c43c14dc59e8e3))
* the body parsers enforce what they were told to enforce ([24357b2](https://github.com/nigrosimone/fulmine.js/commit/24357b29414d0ed7ad4b1ba34004733b9a7483da))
* the body parsers follow body-parser on what the review found ([2a242d8](https://github.com/nigrosimone/fulmine.js/commit/2a242d8e400066fdcf8c427006306eaf8370b744))
* the default error handler answers with the status the error carries ([520560d](https://github.com/nigrosimone/fulmine.js/commit/520560d5ec0c739cc0f2290ffcecc4696454846a))
* the dispatch survives its own throws, and five routing bugs ([da3bb65](https://github.com/nigrosimone/fulmine.js/commit/da3bb65c6e4887d60ef395dcc2a0c83f348561a3))
* the node shim holds the body chunk for whoever reads next ([98d5bbc](https://github.com/nigrosimone/fulmine.js/commit/98d5bbcee833a404e73ddeb4e29eda7406b4bd16))

### Performance Improvements

* a route knows what its callbacks are before the first request ([1e47428](https://github.com/nigrosimone/fulmine.js/commit/1e47428cd973a32a232c93c52c564853af1bffcb))
* next() is made once per router entry, not once per hop ([6970014](https://github.com/nigrosimone/fulmine.js/commit/69700148260d00edf0e3a7d647b6eb32e2a96a99))
* the rare branches move out of the hot dispatch functions ([228c1b6](https://github.com/nigrosimone/fulmine.js/commit/228c1b6ea2444f330da65765fcc662acbdf5f760))

## 5.0.0-rc.1 (2026-08-03)

### Features

- add missing function getHeaders on response ([985d9a0](https://github.com/nigrosimone/fulmine.js/commit/985d9a05650dd9f7c69836283ab446182e7a4fe0))
- add more test ([1270416](https://github.com/nigrosimone/fulmine.js/commit/1270416f126a800a648da08ec37624f93e26823e))
- add setter for query and headers ([a15fc2a](https://github.com/nigrosimone/fulmine.js/commit/a15fc2ae89393d3ccf2c4d72647ce91b8bc87e73))
- add test ([9fecbbb](https://github.com/nigrosimone/fulmine.js/commit/9fecbbb40d969d6d6fc04821a48f94b9d33b558e))
- add test for helmet ([869099b](https://github.com/nigrosimone/fulmine.js/commit/869099b9de2100727f4c77bb63171a7628ecae67))
- add test to res.writeHead() ([7198f12](https://github.com/nigrosimone/fulmine.js/commit/7198f125e1369be54512570821909ba9a9b1e88b))
- add tests ([e3cc99c](https://github.com/nigrosimone/fulmine.js/commit/e3cc99c6b9434da736b24a5062f3e54017f08c29))
- always send chunks if 100ms elapsed from last write ([a8282b1](https://github.com/nigrosimone/fulmine.js/commit/a8282b1bd190e9f8c0268ed0611fcb3245f17702))
- an app is a function again, and can serve node's own requests ([e6ed469](https://github.com/nigrosimone/fulmine.js/commit/e6ed46953a9a316572aa00043f0e73ea2b99b52a))
- declarative response sendStatus ([7832de1](https://github.com/nigrosimone/fulmine.js/commit/7832de1557e1cef2d472e52660c29a80dbdce4b2))
- every verb node knows has a method, bind included ([a3e83f5](https://github.com/nigrosimone/fulmine.js/commit/a3e83f50edbff750458ece4b929e545e2e6b7b50))
- fix supertest support ([a06e6d2](https://github.com/nigrosimone/fulmine.js/commit/a06e6d23b97dce249f8ffbaa10adcdf2982e4a0c))
- handle(), and the verb methods where they belong ([6a8b10f](https://github.com/nigrosimone/fulmine.js/commit/6a8b10f230f9d0d8b4e2e4f91c4ffe2b12fcac80))
- implement matrix testing for backward compatibility support ([30b5fed](https://github.com/nigrosimone/fulmine.js/commit/30b5fed7a6ebc1b0b6e284eb16918738df0d67a8))
- implement matrix testing for backward compatibility support ([a4697ca](https://github.com/nigrosimone/fulmine.js/commit/a4697ca2a3e27f0060edb6060a4f9c4596d260e0))
- implement matrix testing for backward compatibility support ([454a297](https://github.com/nigrosimone/fulmine.js/commit/454a2973667b44b3f6feb0fffd53479d6a8e401e))
- jsconfig and tsconfig ([d53049e](https://github.com/nigrosimone/fulmine.js/commit/d53049ee36077af9c7b5b4c48af21ccaab7916d2))
- leave x-powered-by off by default ([b89496d](https://github.com/nigrosimone/fulmine.js/commit/b89496da3232c99a199044492cb85e447e79a1b5))
- make what listen() returns behave like a server ([9526f97](https://github.com/nigrosimone/fulmine.js/commit/9526f976845a1e3bec38599b6cab1b64a36eb1f8))
- remotePort ([168bfef](https://github.com/nigrosimone/fulmine.js/commit/168bfefb9157f131ef98d89fbfadc0a03f9763c2))
- run test both on express@4 and express@5 ([753e2ae](https://github.com/nigrosimone/fulmine.js/commit/753e2aee5c5376510276a6b5b6e1809bdccd4c50))
- server.close ([d0f1f9b](https://github.com/nigrosimone/fulmine.js/commit/d0f1f9bfe645b676a10bbd2eda63a5aa54b0e68c))
- test coverage ([4370fd1](https://github.com/nigrosimone/fulmine.js/commit/4370fd1b50948487e4b371384dd14c4e724d7151))
- **test:** add SKIP_V4 e SKIP_V5 for test ([ffa8c0e](https://github.com/nigrosimone/fulmine.js/commit/ffa8c0ed47e97b2d14852f07f3fd6b3b6f445010))
- **test:** express 5 ([86b520a](https://github.com/nigrosimone/fulmine.js/commit/86b520a0da2e171ff7bf74d44a44986fd6b4c1b5))
- **test:** skip reason ([0c9b71b](https://github.com/nigrosimone/fulmine.js/commit/0c9b71b81a8995b5081b50c5dd7304965ac06d7a))
- **test:** test typescript types are compatible with express ([6f47345](https://github.com/nigrosimone/fulmine.js/commit/6f47345df8f9625a5afc8489bdef35864e3e9173))
- **v5:** apply Express 5 behaviour across the source, drop the v4 arm ([cb22a01](https://github.com/nigrosimone/fulmine.js/commit/cb22a01e568f5abc7eda72960c5cb7ca13ac5767))
- **v5:** replace the path matcher with Express 5 semantics ([20a9099](https://github.com/nigrosimone/fulmine.js/commit/20a90996ca6d696a35129924032153cb7a43b1fb))

### Bug Fixes

- _isLenientHeaderValidation is not a function ([d966045](https://github.com/nigrosimone/fulmine.js/commit/d966045bfb27b2f9a748065244fefd4afbfbbd07))
- [#254](https://github.com/nigrosimone/fulmine.js/issues/254) ([5fa3e93](https://github.com/nigrosimone/fulmine.js/commit/5fa3e93596449c5fdc9e56a793071ee2fd6f7d09))
- [#59](https://github.com/nigrosimone/fulmine.js/issues/59) ([a337ea9](https://github.com/nigrosimone/fulmine.js/commit/a337ea93e4654e54bfdaf422115f1ea8015a77dc))
- [#68](https://github.com/nigrosimone/fulmine.js/issues/68) ([ab16aee](https://github.com/nigrosimone/fulmine.js/commit/ab16aeed140facb376010a7fcfeeee3b45a5042d))
- 270 ([e5e7e30](https://github.com/nigrosimone/fulmine.js/commit/e5e7e3030bef008ec47091a621cad84372db79f1))
- a bad request body is answered 400, not 500 ([0364115](https://github.com/nigrosimone/fulmine.js/commit/0364115222006683bc7df954096035a04bfeb371))
- a callable app or router keeps apply, call and bind ([5f5f619](https://github.com/nigrosimone/fulmine.js/commit/5f5f61981d44b11e982f0b9ab2c6e7b79c3a4324))
- a declarative response carries the same connection headers as any other ([de5f646](https://github.com/nigrosimone/fulmine.js/commit/de5f646d408ad1664b5735f7e594bf8bb8cecda4))
- a directory redirect keeps the query and stays on this server ([4c1fc6e](https://github.com/nigrosimone/fulmine.js/commit/4c1fc6ec92329ef96f5853949f3e1dfd4aef29de))
- a mounted router's strict setting decides its own trailing slashes ([4dde694](https://github.com/nigrosimone/fulmine.js/commit/4dde694b6ee13bc3b53b02f5566e1ea1bfa15ee6))
- a mounted sub-app answers with its own settings ([9989155](https://github.com/nigrosimone/fulmine.js/commit/9989155e15083cc075852c36e65b02171d6a3651))
- a refused file says which refusal it was ([24559c7](https://github.com/nigrosimone/fulmine.js/commit/24559c741163fee95d9e11a47826511ebdde1981))
- a request served through node's own server answers like the others ([d627bbe](https://github.com/nigrosimone/fulmine.js/commit/d627bbe53e4523ecd20bb8a46cb34ffbc4f4183e))
- a request that leaves an optimized mount is routed by its whole path ([822827e](https://github.com/nigrosimone/fulmine.js/commit/822827e46a64e98b516650e2bf868c304b122208))
- a wildcard route answers the root path too ([b3fe94b](https://github.com/nigrosimone/fulmine.js/commit/b3fe94bf677da4c9ffdd0004d4b8cf8852649c25))
- add comment ([34acb3d](https://github.com/nigrosimone/fulmine.js/commit/34acb3d21f83be4556dc17e63af1300fa8cdd56a))
- add setter for baseUrl ([#86](https://github.com/nigrosimone/fulmine.js/issues/86)) ([cb190ab](https://github.com/nigrosimone/fulmine.js/commit/cb190ab4c8f6f01b38c7fc985a128629987fa493))
- an empty declarative response is empty, and its ETag matches its body ([56d7533](https://github.com/nigrosimone/fulmine.js/commit/56d7533b89f0082df3cc6e94d4619ff5bb3952dd))
- answer conditional requests where Express answers them, and stop lying about the connection ([a826ab1](https://github.com/nigrosimone/fulmine.js/commit/a826ab1e1c3da9f03278258e64439d2c11813dc8))
- better-sse ([a6e9a06](https://github.com/nigrosimone/fulmine.js/commit/a6e9a0614716a94050fafc49d597b73dd4ab3792))
- body write ([6fcb0a2](https://github.com/nigrosimone/fulmine.js/commit/6fcb0a24f2497a1264a7380be71340eb4c1aa396))
- bump uWebsockets to 20.70, in hopes of fixing invalid 505 responses ([6c3fede](https://github.com/nigrosimone/fulmine.js/commit/6c3fede71b31f827d19ce73073e73ab637507a43))
- close server ([717419d](https://github.com/nigrosimone/fulmine.js/commit/717419d221a10aba5b150d09fed3057510a46fd0))
- cluster mode ([5d3cf24](https://github.com/nigrosimone/fulmine.js/commit/5d3cf24d22af6e7e065f95771acd09e4fb9cbc33))
- comment ([6a791bd](https://github.com/nigrosimone/fulmine.js/commit/6a791bd5398ef67421fe1ad7a1e1f25631efa01f))
- compute the ETag where Express computes it, and match its charset casing ([631fd39](https://github.com/nigrosimone/fulmine.js/commit/631fd39a7e44c479d219f86aabea0dc9b8b98778))
- content type ([f328cc9](https://github.com/nigrosimone/fulmine.js/commit/f328cc961b7e3edc63aaed16086d6db499e88811))
- content type ([c385745](https://github.com/nigrosimone/fulmine.js/commit/c3857453f8f49207ee1b2401219df54ab5d63924))
- content type and body ([c3db047](https://github.com/nigrosimone/fulmine.js/commit/c3db047ce2aa8391ff4b79545a1e2c8f38a89e4b))
- correct minor grammatical issues in README.md ([352cc4f](https://github.com/nigrosimone/fulmine.js/commit/352cc4f1b003d9829b4fe4a3d0359af455e930f2))
- coverage ([b8d1cc9](https://github.com/nigrosimone/fulmine.js/commit/b8d1cc98d2acd06aafc45d30bb623652502f66ee))
- default content-type ([8ebaf3d](https://github.com/nigrosimone/fulmine.js/commit/8ebaf3db6000749f4199b25019e9099ce5e6c5da))
- deprecate(d) ([f11df41](https://github.com/nigrosimone/fulmine.js/commit/f11df414b025281ba80ee024da5c648473db4574))
- dev package release ([7dbba6c](https://github.com/nigrosimone/fulmine.js/commit/7dbba6c85151b3d4f7918a806d370d914abdd6d4))
- emit if fresh ([17a7742](https://github.com/nigrosimone/fulmine.js/commit/17a7742a54c2afcfd2444eb7a488a73008e69ee7))
- EMPTY_REGEX control. fullMountpath is a RegEx not a string, the replace is always executed. ([aa3ba3b](https://github.com/nigrosimone/fulmine.js/commit/aa3ba3b814434e4f95515a4789334367db3c4541))
- error handler ([b77a0bd](https://github.com/nigrosimone/fulmine.js/commit/b77a0bd072e3d51b533a0971a7cc67eff4f657f9))
- etag case not cover if etag f is truthy ([31766b5](https://github.com/nigrosimone/fulmine.js/commit/31766b57772b8e61e73d3abbeb615479dd60754e))
- give an empty request body the shape express gives it ([ff9d317](https://github.com/nigrosimone/fulmine.js/commit/ff9d3177fe101896e764fd5f97b3a2d063c36cbe))
- includes ([6cc154d](https://github.com/nigrosimone/fulmine.js/commit/6cc154d6add38d59321166b17bc1aa00a82f2575))
- issue 277 ([9f96923](https://github.com/nigrosimone/fulmine.js/commit/9f969231c798062ef1a76135941c2801feff3da9))
- latency issue in benchmark ([a4343c1](https://github.com/nigrosimone/fulmine.js/commit/a4343c1fb3c9590039235d1732220475fa0c97c4))
- latency issue in benchmark ([4e9debc](https://github.com/nigrosimone/fulmine.js/commit/4e9debc0d915396c993cce6e5c1a05e01c75c0a1))
- listen return type ([330803b](https://github.com/nigrosimone/fulmine.js/commit/330803b36472662819e3cec719d7ba03c58d8844))
- lock ([c1fc54a](https://github.com/nigrosimone/fulmine.js/commit/c1fc54a901bb9f586b18312f89a80b3eaab1deb2))
- lookup logic ([ce9eb53](https://github.com/nigrosimone/fulmine.js/commit/ce9eb5357f39782c8608b8806ab09ea7468e7425))
- make req.pipe() works for non-body request ([e69ab37](https://github.com/nigrosimone/fulmine.js/commit/e69ab379d72bdbc765b703c2ce512a3b27f1bdd2))
- mime types ([cc2dca4](https://github.com/nigrosimone/fulmine.js/commit/cc2dca4bead14718cfb1360f30ec0556c63aea1e))
- missing check ([248d1a8](https://github.com/nigrosimone/fulmine.js/commit/248d1a81859f5079df04e384c3036e70316b1422))
- more spreads ([b7fb7ac](https://github.com/nigrosimone/fulmine.js/commit/b7fb7accaf9439e09ab05890b647f495a6d1431a))
- named ESM imports work again, and a test that catches it when they stop ([d459672](https://github.com/nigrosimone/fulmine.js/commit/d4596727be620e6efc8ef713b5af5a970a344bd9))
- no finish event fired ([6d83855](https://github.com/nigrosimone/fulmine.js/commit/6d83855a1c3090e3a0ffba5167844b2831021190))
- polyfills for node 18 ([2f5432d](https://github.com/nigrosimone/fulmine.js/commit/2f5432db88f9c8cd2f9e9cacff46790ea574ec5a))
- polyfills for node 18 ([d70f2d2](https://github.com/nigrosimone/fulmine.js/commit/d70f2d2ddf80e83ec725eccd02aa0dc35b1ab3cd))
- polyfills for node 18 ([6a568d6](https://github.com/nigrosimone/fulmine.js/commit/6a568d61e631546e146296e005c690be4f3cbd72))
- polyfills for node 18 ([9865c6c](https://github.com/nigrosimone/fulmine.js/commit/9865c6c61e6a13619fc8b003510a2e88d5b02e47))
- polyfills for node 18 ([bf7ab8d](https://github.com/nigrosimone/fulmine.js/commit/bf7ab8df2fd25df38da23c8d1cc490b7158e38fb))
- polyfills for node 18 ([1f33605](https://github.com/nigrosimone/fulmine.js/commit/1f33605bd3f17f27c52b3342c132449b50a4b512))
- put express.application back, and let migrate read TypeScript ([fa19f56](https://github.com/nigrosimone/fulmine.js/commit/fa19f563e2ee0768bc9c04916d50d9639ea19db6))
- redirect ([25ac94a](https://github.com/nigrosimone/fulmine.js/commit/25ac94a05fab1d1e1c2931aaf41b69ac50aafa78))
- refuse a keyword major bump, not just an automatic one ([230ea08](https://github.com/nigrosimone/fulmine.js/commit/230ea082084bed35712e1eac2b5c67b1a522f0c1))
- replaced NullObject with {}, for better support ([b1929fe](https://github.com/nigrosimone/fulmine.js/commit/b1929fe3e25af6727c7a44e636ae936ec63dc553))
- replaced NullObject with {}, for better support ([8ab988d](https://github.com/nigrosimone/fulmine.js/commit/8ab988d528027bc33d545ce08d0f21c3d6f3f129))
- req param on route with capturing group ([573ae84](https://github.com/nigrosimone/fulmine.js/commit/573ae845bff4420f53c1a7c868758ee878870031))
- req.param() falsy value ([f738996](https://github.com/nigrosimone/fulmine.js/commit/f738996240fa685927e1119c69fdca2c864924bc))
- req.subdomains() handle ip address ([0a84784](https://github.com/nigrosimone/fulmine.js/commit/0a847843b1fdd0a42db34adced4c5bdbaea2c35c))
- req.xhr case-insensitive ([0bc0ba9](https://github.com/nigrosimone/fulmine.js/commit/0bc0ba9539261d4a8802e305d09c5b217b9df44e))
- res.links, res.vary and res.jsonp answer what express answers ([35a08cd](https://github.com/nigrosimone/fulmine.js/commit/35a08cdf8479f11e3804dac37611d9345e663aa8))
- res.links() append to existing header instead of overwriting ([d7907b7](https://github.com/nigrosimone/fulmine.js/commit/d7907b7b1f6b3db2f5555c75acf127af71e5e725))
- res.location should be chainable ([d0b3d5c](https://github.com/nigrosimone/fulmine.js/commit/d0b3d5cb9c5373f3da448e7174073ea5f8ce6a92))
- res.redirect full & fast html escaping ([aec9785](https://github.com/nigrosimone/fulmine.js/commit/aec97852936b73f3b011a9c33e64e04ddc73c2b4))
- res.send takes a typed array, and an etag function may decline ([d45c807](https://github.com/nigrosimone/fulmine.js/commit/d45c807426121d48fcf8692472828c8013db26bf))
- res.senStatus content-type to text/plain ([b05030d](https://github.com/nigrosimone/fulmine.js/commit/b05030d1a700a3df56bd2ff3a6153d51e807c7a1))
- res.status, res.set and res.cookie refuse what express refuses ([f19d62a](https://github.com/nigrosimone/fulmine.js/commit/f19d62aad8c9053ef7252ffd6f837e51e33d663b))
- **response:** handle missing filename in res.attachment ([b75a31c](https://github.com/nigrosimone/fulmine.js/commit/b75a31c840d16a3accf7422ee36d038f75f5d5df))
- return an empty object ([69e7d66](https://github.com/nigrosimone/fulmine.js/commit/69e7d66a9c5aa399506137c4f14ea836003196bd))
- return an empty object ([c4a3ada](https://github.com/nigrosimone/fulmine.js/commit/c4a3ada89207889290222aaa314f1b744f4738c5))
- return what Express returns from the chainable methods ([53aa06d](https://github.com/nigrosimone/fulmine.js/commit/53aa06d16ab1c3b952d492c8933856da8c02fa39))
- route parameters reach the application decoded ([25e269b](https://github.com/nigrosimone/fulmine.js/commit/25e269be2b83cab7f645173a541b860cc025e909))
- **routing:** multi param route ([e9440af](https://github.com/nigrosimone/fulmine.js/commit/e9440afb4d466d0060ce1845bc2f357c4a92d28b))
- run the listen callback on the next tick, as Express does ([af433a4](https://github.com/nigrosimone/fulmine.js/commit/af433a42f945674b5c6639f01efc1a3916881514))
- send() tells undefined from empty, and the two paths agree on content-type ([ddb39a7](https://github.com/nigrosimone/fulmine.js/commit/ddb39a73c5dece738e88aaeeb1f7b43ee289fec3))
- shared references for large bodies. ([31d6c40](https://github.com/nigrosimone/fulmine.js/commit/31d6c40562a7863a295b47a10b7530a0bc59db6b)), closes [#42](https://github.com/nigrosimone/fulmine.js/issues/42)
- stop body parsers from responding twice to an oversized body ([93bf851](https://github.com/nigrosimone/fulmine.js/commit/93bf8516d3a6e8d5094d770833600452ea106047))
- test ([d6becb7](https://github.com/nigrosimone/fulmine.js/commit/d6becb74bd4ec8dab9c8b488b4f4edef99337686))
- test ([5efa73e](https://github.com/nigrosimone/fulmine.js/commit/5efa73ef11e6f149addfffd3f8dac09e5cf28fe4))
- test 5 ([11e412e](https://github.com/nigrosimone/fulmine.js/commit/11e412eaec35a08773834e4328feba2aa7ff6a62))
- **test:** double check writeHead return this ([fd51fdd](https://github.com/nigrosimone/fulmine.js/commit/fd51fddb549076a9d284106bf9a9f9d249bcc567))
- **test:** fixed misunderstanding of array of callback case ([d87a010](https://github.com/nigrosimone/fulmine.js/commit/d87a010e52947365d8ce138eda796a907671bb21))
- **test:** node.js internal fast null object creation inspect ([8bedb11](https://github.com/nigrosimone/fulmine.js/commit/8bedb111061a143e7360dacff532760e2a6fbabc))
- **test:** read header ([4c75547](https://github.com/nigrosimone/fulmine.js/commit/4c755479932b7070f5e68795a077740ca995ef60))
- **tests/middlewares/better-sse:** use node http/1 connection adapter for compatibility ([fc0e4fc](https://github.com/nigrosimone/fulmine.js/commit/fc0e4fcbb82d62ac2e5f3ba9757a887259c6b344))
- the changelog links point at this repository, not the one it was forked from ([227d8db](https://github.com/nigrosimone/fulmine.js/commit/227d8dbb11344f3eb71789218d20cd8014a44aa6))
- the command is installed as fulmine, since npx cannot run one ending in .js ([7c00d69](https://github.com/nigrosimone/fulmine.js/commit/7c00d695586e58c931e19d1bb4fd0e6c97a9a810))
- the release script does not need an upstream branch ([6303b3c](https://github.com/nigrosimone/fulmine.js/commit/6303b3c01320ef8bfa1fa3dc6aa7a5dc39173269))
- the tools spawn npm through the command interpreter on windows ([df41c67](https://github.com/nigrosimone/fulmine.js/commit/df41c679a73707b5b2fb07f6a6d39c4d5ab9ae26))
- try different port ([57391ec](https://github.com/nigrosimone/fulmine.js/commit/57391ecf2d70c84920bba60fe4ab847f0928e38a))
- tsconfig for latest vscode ([6bbd47c](https://github.com/nigrosimone/fulmine.js/commit/6bbd47cfd1b81a849b489214af7b6c78ff798c76))
- **types:** return type of listen ([7a2f168](https://github.com/nigrosimone/fulmine.js/commit/7a2f1685c0cb903704771b0b9cf894cd0c69d696))
- typo ([eba058b](https://github.com/nigrosimone/fulmine.js/commit/eba058b7d263ae3d1c47b6c31b4fba34a949f486))
- unnamed param ([3967c40](https://github.com/nigrosimone/fulmine.js/commit/3967c4011332a414caee2003e95a38890a710388))
- update other property when query changes ([b357d4a](https://github.com/nigrosimone/fulmine.js/commit/b357d4abce2d8cd53e44ce629e9c15bd1637c058))
- update README.md to clarify load generator dependency ([72fd09d](https://github.com/nigrosimone/fulmine.js/commit/72fd09d1192f771399a4dc9b707f644168b9da5b))
- use "," instead of ";" as separator of multiple cookie ([4e66255](https://github.com/nigrosimone/fulmine.js/commit/4e6625588d49821e4f3709cc9f91c916807b8a73))
- use correct now ([795082e](https://github.com/nigrosimone/fulmine.js/commit/795082edb17ccf34d8a7610e8fe37844eb36d088))
- use internal lookup and resolve of View class ([5ec4bed](https://github.com/nigrosimone/fulmine.js/commit/5ec4bed3e7f5de40a484b8c9165aa862e5f83847))
- use performance.now() ([cc88013](https://github.com/nigrosimone/fulmine.js/commit/cc880138143ff12a1a3ff1c9e5a4f0593fd1b5ef))
- uWebsocket version ([0790d34](https://github.com/nigrosimone/fulmine.js/commit/0790d347f3b3b3c4f18f01efabb8f2a628d952ff))
- uws don't support callback on close ([5fcb590](https://github.com/nigrosimone/fulmine.js/commit/5fcb590f891e9d75690cbbc696ad3c0cd4f837e8))
- uws exclusive port ([d7351fd](https://github.com/nigrosimone/fulmine.js/commit/d7351fd28e61eb825bf6de532f1a611f39c9b751))
- uws has different timing on listen/callback ([4df1ab0](https://github.com/nigrosimone/fulmine.js/commit/4df1ab0de281ce736bdd2302efe1e251a67c7eae))
- **v5:** make the path matcher accept and reject exactly what Express 5 does ([9670b08](https://github.com/nigrosimone/fulmine.js/commit/9670b083cf04effb535a84e9a1d1d41671fdccf8))
- **v5:** print like Express, and remove the APIs instead of inventing errors ([d2e2ae2](https://github.com/nigrosimone/fulmine.js/commit/d2e2ae22ef1841959bf1d2e1cf26c8fa93be350b))
- **v5:** res.send(number), the Allow header, and the .js media type ([9e79d24](https://github.com/nigrosimone/fulmine.js/commit/9e79d2483941f8eb548e1aa57168337d948fef39))
- **v5:** simple query parser by default, null-prototype params, Allow on the app path ([68e2c51](https://github.com/nigrosimone/fulmine.js/commit/68e2c51022e0524571e214a5378cf33f4ce97685))
- **v5:** stop parsing bodies that are not there, and keep req.query null-prototype ([2093f4b](https://github.com/nigrosimone/fulmine.js/commit/2093f4bbb41b2847899ec4f5e5d646b03f467be3))
- **v5:** the last three divergences, suite green against Express 5 ([8bdf14d](https://github.com/nigrosimone/fulmine.js/commit/8bdf14dd5f9aeda77ea3e43dd21f089c89c3f60c))
- value ([9595188](https://github.com/nigrosimone/fulmine.js/commit/9595188737e17b5de122c05c9b4bbabda7b1902d))
- value ([28ec3a9](https://github.com/nigrosimone/fulmine.js/commit/28ec3a9c919404b02992902492c4b2655f2be8fb))
- wait for write ([792bee0](https://github.com/nigrosimone/fulmine.js/commit/792bee00ee045f631750e0f005c333b6ec78bff5))
- writeHead return this ([1406082](https://github.com/nigrosimone/fulmine.js/commit/1406082652dc2ee2c0deca321962c3ac5fa41db8))

### Performance Improvements

- a parameter route in a mounted router reaches the native router ([5b805e9](https://github.com/nigrosimone/fulmine.js/commit/5b805e9c687e8308ca2f07ba543bfd2dc805d2b4))
- a route carries its param callbacks rather than looking them up ([53761c6](https://github.com/nigrosimone/fulmine.js/commit/53761c69cb101278b298453d046c01a3ac5eb4d5))
- a route with parameters is served by the native router ([b365c10](https://github.com/nigrosimone/fulmine.js/commit/b365c10eadc76b4d1e51e7559e9c50819adad8e2))
- a router with param callbacks is optimized like any other ([39d1fd5](https://github.com/nigrosimone/fulmine.js/commit/39d1fd5f708ddba806e8365ab95ecbe6e999800b))
- a use with no path does not recompute the path it did not change ([023ffda](https://github.com/nigrosimone/fulmine.js/commit/023ffdabac762b113675970311211fc0a60883fe))
- avoid unnecessary function call ([5fa8326](https://github.com/nigrosimone/fulmine.js/commit/5fa832688096ba661641149e4cedcc13448aece6))
- avoid useless regex ([211c127](https://github.com/nigrosimone/fulmine.js/commit/211c127149a9bbce6cc941bff7ea17aa6d5c1ba2))
- better performance with replaceAll ([65d077f](https://github.com/nigrosimone/fulmine.js/commit/65d077fb3f7092a618b0321e0209a96f6de06b04))
- better performance with replaceAll ([3e6afe4](https://github.com/nigrosimone/fulmine.js/commit/3e6afe4ff20e3f12892f04f6bb8a8e3e146ae2c1))
- build less of a Request before anyone has asked for it ([841642f](https://github.com/nigrosimone/fulmine.js/commit/841642fb614882a207d7493cfa461799f2dd8a2f))
- cache array length ([7c0b608](https://github.com/nigrosimone/fulmine.js/commit/7c0b6082007d0cad7b17c1563064230c9d0eefbd))
- cache body methods on first request ([1374eea](https://github.com/nigrosimone/fulmine.js/commit/1374eea8bc0aef2db5ae2112b3bcb486a2ed54b8))
- cache compilation of regex ([793181a](https://github.com/nigrosimone/fulmine.js/commit/793181a864221b05eaf15db7b8ea86d2c8cba3ed))
- cache compilation of regex ([910cc9f](https://github.com/nigrosimone/fulmine.js/commit/910cc9fb6784ecc81db1238e9f6e447368589d7e))
- cache empty regex ([abb76b5](https://github.com/nigrosimone/fulmine.js/commit/abb76b5d7c7321fe5d7a82e106ea405694a1d779))
- compile res.json and a returned res.send, and read the calls in the order they run ([725b429](https://github.com/nigrosimone/fulmine.js/commit/725b4291614587c598ece77453ee0fe6614c29e3))
- compute the ETag without allocating a hash object per response ([6e23685](https://github.com/nigrosimone/fulmine.js/commit/6e23685a6aaa9eec44a136a55ed9a94d3b1b644d))
- cut the per-hop cost of the router dispatch chain ([77a07ab](https://github.com/nigrosimone/fulmine.js/commit/77a07ab0ce1d2d8d6117dec990f1291d632af946))
- don't parse query if query is empty ([1301b77](https://github.com/nigrosimone/fulmine.js/commit/1301b77d1e10da2755267b6fa73bba29c8f286b8))
- don't parse query if query is empty ([0be1a71](https://github.com/nigrosimone/fulmine.js/commit/0be1a71b77a324ee3b6deb54310ea2775dfd3c3b))
- fast getFullMountpath on empty middleware ([6e6e457](https://github.com/nigrosimone/fulmine.js/commit/6e6e457b5edc9c41c532e4a94b0ee653b277f27b))
- keep route patterns as plain RegExps ([2e9b5bc](https://github.com/nigrosimone/fulmine.js/commit/2e9b5bc683feb79553c97afdccdd3a6afafad26b))
- micro-opti ([d815de8](https://github.com/nigrosimone/fulmine.js/commit/d815de89fcad9ec8977722f6fee06c49464a3399))
- micro-optimization avoid multiple call to map ([50e6706](https://github.com/nigrosimone/fulmine.js/commit/50e6706159c3e8ff629a2f76d282964714e11219))
- optimization ([3b17f93](https://github.com/nigrosimone/fulmine.js/commit/3b17f93a0a4aa6a8781cb99b24bdaeb38c531f9c))
- optimize routing ([d825a75](https://github.com/nigrosimone/fulmine.js/commit/d825a7501f86a9f93dab56d53b436d48be148cea))
- optimize routing ([7f51e75](https://github.com/nigrosimone/fulmine.js/commit/7f51e756242661237b38d5c8834cb518f8ee5f95))
- parse the query without slicing and copying twice ([3a7e75a](https://github.com/nigrosimone/fulmine.js/commit/3a7e75a7a0f158fb5e1008de86355828c72f698f))
- read a route's parameters by name instead of walking the match ([acc310f](https://github.com/nigrosimone/fulmine.js/commit/acc310fb0fd47f41614a094bdfba532f24a16d58))
- remove per-request async overhead in router dispatch ([6f6c8c1](https://github.com/nigrosimone/fulmine.js/commit/6f6c8c1fa37017bed745eabdf2e8445dcc39507d))
- removed useless call ([7574f7b](https://github.com/nigrosimone/fulmine.js/commit/7574f7bdb124c4f46fa99e26fc5fdcab4080e50f))
- replace arrays with sets for improved performance in request and router modules ([7f77504](https://github.com/nigrosimone/fulmine.js/commit/7f77504e65d8c5f1496c97d8d3eccd80ef487d73))
- **req:** collapse 3-layer body buffering, uWS pause/resume ([6648176](https://github.com/nigrosimone/fulmine.js/commit/664817680d141592f6b999422d23fdf25fa558f3))
- skip full headers build in req.fresh when no conditional headers ([f778739](https://github.com/nigrosimone/fulmine.js/commit/f7787398f079bddb6eee204d502d1091ae0aa4f6))
- some request optimization ([0424790](https://github.com/nigrosimone/fulmine.js/commit/042479080e6d4ab8255bf36423fdbacd66ae9c6d))
- some request optimization ([2163854](https://github.com/nigrosimone/fulmine.js/commit/21638540e33153ed57e77dc85f97465a7673a35a))
- stop allocating an array per request header, and build the node header shim on demand ([4a01818](https://github.com/nigrosimone/fulmine.js/commit/4a018182b8fe3508890193304abcfda5e01ad2a7))
- stop copying request bodies twice ([9335723](https://github.com/nigrosimone/fulmine.js/commit/93357232c328badac50f20f1999f6732bc3fc1be))
- stop paying for two regular expressions on every string body, and let ab.js see a change ([91c09d6](https://github.com/nigrosimone/fulmine.js/commit/91c09d67b20d03c6dcf3e17770e974d90c32fdec))

### Reverts

- removal of nullObject ([ba205e9](https://github.com/nigrosimone/fulmine.js/commit/ba205e9b17a61da5af5aaaa5becb8c7ca527d129))
