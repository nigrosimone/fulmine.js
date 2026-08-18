// Differential fuzzing against express.
//
// The suite compares hand written cases. This builds random ones instead: a random application
// shape, registered on real express and on fulmine, hit with hostile urls, and every answer
// compared. Anything the two disagree on is a compatibility bug in one of them, and it is usually
// ours.
//
//   node tools/fuzz.js                     a few hundred rounds
//   node tools/fuzz.js --rounds 500        longer
//   node tools/fuzz.js --seed 12345        replay exactly what a past run did
//   node tools/fuzz.js --keep-going        do not stop at the first divergence
//   node tools/fuzz.js --self             compare this framework against itself with the
//                                          optimizer off, instead of against express
//
// Two things make it a tool rather than a lucky script. Every round is drawn from a seeded
// generator, so a failure prints the seed that reproduces it. And a failure is then shrunk: routes
// and settings are dropped one at a time for as long as the divergence survives, which turns a
// forty route accident into the two lines worth pasting into tests/.

const fs = require("fs");
const os = require("os");
const path = require("path");
const realExpress = require(path.join(__dirname, "..", "node_modules", "express"));
const fulmine = require(path.join(__dirname, "..", "src", "index.js"));
const { COMPARED_HEADERS, PRESENCE_ONLY_HEADERS } = require(path.join(__dirname, "..", "tests", "helpers.js"));
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const methodOverride = require("method-override");
const compression = require("compression");
const responseTime = require("response-time");
const morgan = require("morgan");
const basicAuth = require("express-basic-auth");

// x-powered-by, content-length and transfer-encoding stay out for the reasons tests/helpers.js
// gives: the two servers differ there by design rather than by fault.

// What the third party middleware below writes, compared on top of the suite's list. Injecting a
// middleware whose whole output is headers nobody looks at would prove nothing, so these are here
// rather than in tests/helpers.js: the suite compares them by printing them in the case that uses
// them, and widening its list would rewrite every expected file for no gain.
// x-response-time is deliberately absent: it is a clock reading.
const MIDDLEWARE_HEADERS = [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-expose-headers",
    "access-control-max-age",
    "www-authenticate",
    "content-security-policy",
    "cross-origin-embedder-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
    "origin-agent-cluster",
    "referrer-policy",
    "strict-transport-security",
    "x-content-type-options",
    "x-dns-prefetch-control",
    "x-download-options",
    "x-frame-options",
    "x-permitted-cross-domain-policies",
    "x-xss-protection"
];

// --self compares this framework against itself with the optimizer off instead of against Express.
//
// Every native registration, compiled response and granted skip is a claim that µWS answering by
// itself gives the answer the ordinary chain would have given. That claim is what this project is,
// and it is where the bugs have been: the analysis reading a pattern as narrower than it is, a
// route that never gets its turn, a guard that does not fire. Comparing the two arms tests it
// directly, with no second framework in the way, so it also reaches the shapes Express has no
// opinion about. A divergence here is a bug by construction: the same code answered the same
// request two different ways.
const SELF = process.argv.includes("--self");
const LEFT = SELF ? "generic" : "express";
const RIGHT = SELF ? "native " : "fulmine";

/** @param {number} seed @returns {() => number} the same sequence for the same seed */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SEGMENTS = ["a", "b", "users", "posts", "me", "list", "x1", "Mixed"];
const PARAM_VALUES = ["1", "abc", "x-y", "%41", "%2F", "a.b", "-", "9", "a%00b", "%C3%A9", "a+b", "a b", ".hidden"];
const SUFFIXES = [
    "",
    "?",
    "?q=1",
    "?q",
    "?a=1&a=2",
    "?%2F=%2F",
    "#frag",
    "?q=1#frag",
    "?=",
    "?callback=cb",
    "?cb=fn",
    "?callback=not a name"
];
// QUERY is one of the four this project reads a body for, so leaving it out meant the verb whose
// body handling is least like the others was never asked for. PATCH is here for the same reason.
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "QUERY"];

// What a request carries when the plan put a body parser in front. Several shapes per parser, not
// one: the body that parses is the least interesting of them, and the answers to an empty body, to
// one that cannot be parsed, to a charset nobody can decode and to a type the parser must leave
// alone are each decided somewhere else in the middleware. One is drawn per round.
const BODIES_FOR = {
    json: [
        { type: "application/json", text: '{"a":1,"b":[2,3],"c":{"d":"e"}}' },
        // each parser turns an empty body into its own empty value rather than leaving req.body set
        { type: "application/json", text: "" },
        // 400 entity.parse.failed, and the message carries the offending text
        { type: "application/json", text: '{"a":' },
        { type: "application/json", text: "{'a':1}" },
        // strict mode: a bare value is not an object, which body-parser refuses by default
        { type: "application/json", text: '"a string"' },
        { type: "application/json", text: "123" },
        { type: "application/json", text: "null" },
        { type: "application/json; charset=utf-8", text: '{"a":"caffè"}' },
        { type: "application/json; charset=iso-8859-1", text: '{"a":"caffe"}' },
        // 415, and before the verify hook rather than after it
        { type: "application/json; charset=nonsense", text: '{"a":1}' },
        // the wrong type for this parser, which must leave the request alone
        { type: "text/plain", text: '{"a":1}' }
    ],
    urlencoded: [
        { type: "application/x-www-form-urlencoded", text: "a=1&b[]=2&b[]=3&c[d]=e" },
        { type: "application/x-www-form-urlencoded", text: "" },
        { type: "application/x-www-form-urlencoded", text: "a" },
        { type: "application/x-www-form-urlencoded", text: "a=&b=" },
        { type: "application/x-www-form-urlencoded", text: "a=1&a=2&a=3" },
        { type: "application/x-www-form-urlencoded", text: "a%5Bb%5D%5Bc%5D=deep" },
        { type: "application/x-www-form-urlencoded", text: "%C3%A9=%C3%A8" },
        { type: "application/x-www-form-urlencoded", text: "a=%ZZ" },
        { type: "application/json", text: "a=1" }
    ],
    text: [
        { type: "text/plain", text: "a body of plain text" },
        { type: "text/plain", text: "" },
        { type: "text/plain; charset=utf-8", text: "caffè" },
        { type: "text/plain; charset=iso-8859-1", text: "caffe" },
        { type: "text/plain; charset=nonsense", text: "text" },
        { type: "text/html", text: "<p>markup</p>" }
    ],
    raw: [
        { type: "application/octet-stream", text: "bytes" },
        { type: "application/octet-stream", text: "" },
        { type: "application/octet-stream", text: "\u0000\u0001binary\u00ff" },
        { type: "text/plain", text: "bytes" }
    ]
};

// The middleware an application really installs, drawn into the plan and registered on both arms.
//
// Unlike the body parsers, which each framework brings its own copy of, both arms here get the
// same npm package. There is no second implementation to compare, so a divergence is our request
// and response surface behaving differently under code that neither framework wrote, which is the
// gap integrations/ covers for whole frameworks and this covers one layer down. It reaches what a
// generated handler cannot: on-headers, on-finished, a middleware that answers instead of calling
// next, and a response stream somebody else writes.
//
// Each entry draws its options as plain data, so the shrinker can drop it and the printed case can
// name it. `headers` adds what the request has to carry for the middleware to do anything.
//
// Left out, and why:
//   express-session, cookie-session           a session id and an expiry drawn from the clock
//   express-rate-limit                        counts across rounds, and its headers carry a reset
//   errorhandler                              writes the stack, whose frames belong to each project
//   express-mongo-sanitize                    assigns to req.query, which express 5 refuses: the
//                                             message it throws names the request class, and ours
//                                             is not a node IncomingMessage
//   http-proxy-middleware, express-http-proxy  want an upstream to talk to
//   multer, express-fileupload                want a multipart body, which nothing here generates
const SINK = { write: () => {} };
const MIDDLEWARE = {
    cors: {
        draw: (pick, chance) => {
            const options = {};
            if (chance(0.5)) options.origin = pick(["*", "http://example.com", true, false]);
            if (chance(0.3)) options.credentials = true;
            if (chance(0.3)) options.methods = pick(["GET,POST", ["GET", "PUT"]]);
            if (chance(0.25)) options.allowedHeaders = ["X-Fuzz", "Content-Type"];
            if (chance(0.25)) options.exposedHeaders = ["X-Lit", "ETag"];
            if (chance(0.25)) options.maxAge = 600;
            // the preflight either ends here or is handed on to the routing, which are two
            // different things for the request to be answered by
            if (chance(0.2)) options.preflightContinue = true;
            if (chance(0.2)) options.optionsSuccessStatus = 200;
            return options;
        },
        build: (options) => cors(options),
        // a preflight is an OPTIONS carrying both of these, and OPTIONS is one of the drawn verbs
        headers: (pick, chance) => ({
            origin: "http://example.com",
            ...(chance(0.5) ? { "access-control-request-method": pick(["PUT", "DELETE"]) } : {})
        })
    },
    helmet: {
        draw: (pick, chance) => {
            const options = {};
            if (chance(0.3)) options.contentSecurityPolicy = false;
            if (chance(0.25)) options.strictTransportSecurity = false;
            if (chance(0.2)) options.crossOriginResourcePolicy = { policy: "cross-origin" };
            if (chance(0.2)) options.referrerPolicy = { policy: "no-referrer-when-downgrade" };
            if (chance(0.15)) options.xFrameOptions = { action: "sameorigin" };
            return options;
        },
        build: (options) => helmet(options)
    },
    cookieParser: {
        // without the secret a signed cookie raises, and one handler kind writes one
        draw: (pick, chance) => (chance(0.5) ? { secret: "fuzz-secret" } : {}),
        build: (options) => cookieParser(options.secret),
        headers: () => ({ cookie: "fuzz=earlier; empty=; broken=%E0%A4%A" })
    },
    methodOverride: {
        draw: (pick) => ({ from: pick(["X-HTTP-Method-Override", "X-Method"]) }),
        build: (options) => methodOverride(options.from),
        // the verb the routing sees is then not the verb the request was sent with
        headers: (pick, chance) => (chance(0.6) ? { "x-http-method-override": pick(["POST", "PUT", "DELETE"]) } : {})
    },
    compression: {
        // threshold 0 so a short generated body is compressed too: the default leaves everything
        // here uncompressed and the middleware never writes
        draw: (pick) => ({ threshold: pick([0, 1024]) }),
        build: (options) => compression(options),
        headers: (pick) => ({ "accept-encoding": pick(["gzip", "deflate", "gzip, deflate, br"]) })
    },
    responseTime: {
        // its own header is a clock reading and stays out of the comparison. It is here for
        // on-headers, which is what it hangs the value on and where the header block is decided
        draw: () => ({}),
        build: () => responseTime()
    },
    morgan: {
        // the line goes nowhere: this is here for on-finished, which is where it reads the answer
        draw: (pick) => ({ format: pick(["tiny", "short", "combined"]) }),
        build: (options) => morgan(options.format, { stream: SINK })
    },
    basicAuth: {
        draw: (pick, chance) => ({ challenge: chance(0.5) }),
        build: (options) => basicAuth({ users: { fuzz: "secret" }, challenge: options.challenge }),
        // most rounds send credentials that work, since a round answering 401 everywhere compares
        // the middleware and nothing else
        headers: (pick, chance) =>
            chance(0.7) ? { authorization: "Basic " + Buffer.from("fuzz:secret").toString("base64") } : {}
    }
};
const MIDDLEWARE_NAMES = Object.keys(MIDDLEWARE);

// Every path written in the case corpus of path-to-regexp, the library express matches with. It
// holds both sides of their tests, the patterns and the concrete paths they are matched against,
// so the same list serves as route vocabulary and as request vocabulary. It is what brings in the
// shapes nobody would think to generate: escapes, extensions, unicode, percent-encoding, optional
// groups, and wildcards with a suffix.
// Taken from pillarjs/path-to-regexp, src/cases.spec.ts.
const LIBRARY_PATHS = [
    "/",
    "/:test",
    "/:a:b",
    "/:_",
    "/:café",
    "/*path",
    "/test",
    "/test/",
    "/*test",
    "/TEST/",
    "/test//",
    "/route",
    "/route/",
    "/route.json",
    "/route.json/",
    "/caf%C3%A9",
    "/;,:@&=+$-_.!~*()",
    "/param%2523",
    "/TEST",
    "/route/nested",
    "/route/nested/",
    "/bar",
    "/foo/bar",
    "/:test/",
    "/foo/bar/",
    "/foo-bar",
    "/foo-bar/",
    "/{:test}-bar",
    "/-bar",
    "/test.json",
    "/:test.json",
    "/route.json.json",
    "/:test.:format",
    "/route.html",
    "/route.html.json",
    "/:test{.:format}",
    "/route.json.html",
    "/:test.:format\\z",
    "/route.htmlz",
    "/\\(testing\\)",
    "/(testing)",
    "/.\\+\\*\\?\\{\\}=^\\!\\:$\\[\\]\\|",
    "/.+*?{}=^!:$[]|",
    "/:foo/:bar",
    "/match/route",
    "/:foo\\(test\\)/bar",
    "/foo(test)/bar",
    "/:foo\\?",
    "/route?",
    "/{:pre}baz",
    "/foobaz",
    "/baz",
    "/:foo\\(:bar\\)",
    "/hello(world)",
    "/:foo\\({:bar}\\)",
    "/hello()",
    "/foo-ext",
    "/foo/bar-ext",
    "/:required{/:optional}-ext",
    "/:foo",
    "/café",
    "/user{s}/:user",
    "/user/123",
    "/users/123",
    "/*path.:ext",
    "/test.html",
    "/test.html/nested.json",
    "/:path.*ext",
    "/test.html/nested",
    "/*path{.:ext}",
    "/test/nested.html",
    "/entity/:id/*path",
    "/entity/foo/path",
    "/*foo/:bar/*baz",
    "/x/y/z",
    "/1/2/3/4/5",
    "/test/nested",
    "/*path/",
    "/foo/bar/baz/",
    "/foo/bar.html",
    "/foo/bar.html/baz.html",
    "/:foo{/test/:bar}",
    "/route/test/again",
    "/abc{abc:foo}",
    "/abc",
    "/abcabc123",
    "/abcabcabc123",
    "/abcabcabc",
    "/:foo{abc:bar}",
    "/abcabc",
    "/acb",
    "/123",
    "/123abcabc",
    "/:foo\\abc:bar",
    "/route|:param|",
    "/route|world|",
    "/:foo|:bar|",
    "/hello|world|",
    "/:foo{|:bar|}",
    "/hello||",
    "/*foo-:bar",
    "/a-b",
    "/a-b-c-d",
    "/*foo-*bar-:baz",
    "/a-b-c",
    "/*foo-:bar-*baz",
    "/*foo-:bar-*baz-:qux",
    "/*foo-*bar",
    "/:foo-:bar-*baz",
    "/:foo-:bar-*baz-:qux",
    "/a-b-c-d-e",
    "/a-b-c/d-e-f",
    "/*foo/:bar/*baz/:qux",
    "/a/b/c/d/e",
    "/*foo/abc-:bar/xyz-*baz/:qux",
    "/a/abc-x/xyz-y/z",
    "/a/abc-abc/xyz-/xyz-/z",
    "/a/abc-abc/xyz-/xyz-a/z",
    "/a/abc/abc-abc/xyz-/xyz-a/z",
    "/abc-/abc-abc/xyz-/xyz-a/z",
    "/*a@:b-*c",
    "/foo@bar-baz",
    "/:a-*b.:c@*d",
    "/a-b.c@d",
    "/a-b-c.d.e@f@g",
    "/*a--*b@@:c",
    "/a--b@@c",
    "/a--b/c@@d--e@@f",
    "/*a~~:b~~*c/:d",
    "/a~~b~~c/d",
    "/*a--*b-.-:c",
    "/a--b-.-c",
    "/*a~~*b._.:c",
    "/a~~b._.c",
    "/*a@@*b~.~:c",
    "/a@@b~.~c",
    "/*a-.-*b@@:c",
    "/a-.-b@@c",
    "/*a@.@*b--:c",
    "/a@.@b--c",
    "/*a-@-*b..:c",
    "/a-@-b..c",
    "/x/*a/*b/y",
    "/x/foo/bar/y",
    "/x/*a-:b/*c/y",
    "/x/foo-bar/baz/y",
    "/x/foo-bar/baz-qux/y",
    "/x/*a-:b-:c/*d/y",
    "/x/foo-bar-baz/qux/y",
    "/x/*a-:b-:c-*d/*e/y",
    "/x/foo-bar-baz-qux/quux/y",
    "/x/*a@/*c/y",
    "/x/foo@/y/y",
    "/x/foo@/y/z/y",
    "/:a-:b^*c@*d%:e",
    "/a-b^c@d%e",
    "/hello/world",
    "/x/foo/y/bar/z",
    "/x/foo/y/bar/w",
    "/x/foo/y-/bar/z",
    "/x/foo/y-/bar/w"
];

// filled at startup with the ones express itself accepts as routes, since the corpus deliberately
// includes patterns its parser refuses
const libraryRoutes = [];

// A directory both arms serve from. Written once per run rather than kept between runs, and read
// by both, so the modification time behind every ETag and Last-Modified is the same one: a file
// per arm would differ by a millisecond and every conditional answer would look like a divergence.
const FILE_DIR = path.join(os.tmpdir(), "fulmine-fuzz-files");
const VIEW_DIR = path.join(FILE_DIR, "views");
const VIEWS = {
    "page.html": "<p>{{title}}</p>",
    "other.html": "<p>other {{title}}</p>",
    "sub/deep.html": "<p>deep {{title}}</p>"
};

const FILES = {
    "a.txt": "the quick brown fox jumps over the lazy dog",
    "b.json": '{"name":"b","values":[1,2,3]}',
    "page.html": "<!doctype html><title>page</title><p>page",
    ".hidden": "a dotfile, which the static options have opinions about",
    "sub/index.html": "<!doctype html><title>index</title><p>index",
    "sub/deep.txt": "deep"
};

/** Lays the files down, which has to happen before either arm is asked for one. */
function writeFiles() {
    fs.mkdirSync(path.join(FILE_DIR, "sub"), { recursive: true });
    fs.mkdirSync(path.join(VIEW_DIR, "sub"), { recursive: true });
    for (const [name, body] of Object.entries(FILES)) {
        fs.writeFileSync(path.join(FILE_DIR, name), body);
    }
    for (const [name, body] of Object.entries(VIEWS)) {
        fs.writeFileSync(path.join(VIEW_DIR, name), body);
    }
}

// Every handler answers from the request alone, with nothing drawn from the clock or from a
// counter: two servers must be able to produce the same bytes.
// The kinds whose body is written out rather than closed over. Only these can reach the
// declarative compiler, which reads a handler's source and refuses anything it cannot see through,
// so without them the fuzzer tested every route except the ones µWS answers by itself.
const LITERAL_KINDS = ["lit-send", "lit-json", "lit-status", "lit-header", "lit-end", "lit-type"];

// the kinds that raise, which the skip-friendly mode leaves out: with no error handler of ours
// the answer is express own error page, and its stack is its own frames
// cookie-signed is here because a signed cookie without cookieParser's secret raises, which is
// exactly what it is for: both must refuse it, and say the same thing about it
const RAISES = new Set([
    "throw",
    "next-error",
    "send-file",
    "download",
    "render-missing",
    "render-callback",
    "cookie-signed",
    "throw-string",
    "throw-status",
    "throw-after-send",
    "reject-async",
    "send-file-options"
]);

const HANDLER_KINDS = [
    ...LITERAL_KINDS,
    "next-router",
    "cookie",
    "vary",
    "format",
    "links",
    "send-text",
    "send-json",
    "status-send",
    "send-status",
    "redirect",
    "set-header",
    "type-send",
    "end-empty",
    "params-echo",
    "query-echo",
    "url-echo",
    "async-send",
    "throw",
    "next-error",
    "next-route",
    "body-echo",
    "jsonp",
    "location",
    "redirect-relative",
    "peer",
    "negotiate",
    "send-file",
    "download",
    "render",
    "render-ext",
    "render-missing",
    "render-callback",
    // the response methods nothing here reached before. Each one writes a header the comparison
    // already looks at, so a disagreement shows up rather than being invisible
    "append",
    "attachment",
    "attachment-odd-name",
    "clear-cookie",
    "cookie-options",
    "cookie-signed",
    "set-array",
    "json-scalar",
    "json-array",
    "send-buffer",
    "send-number",
    "no-content",
    "type-odd",
    "location-encoded",
    "redirect-permanent",
    "write-chunks",
    "write-then-status",
    // The request surface, which nothing here read before: every one of these is a pure function
    // of the path and the headers, both of which are already drawn hostile, and none of them can
    // be seen from outside unless a handler writes it into the body.
    "req-echo",
    "req-range",
    "req-types",
    // The error shapes express decides on, which are not the same as throwing an Error: a string
    // has no message, a status on the error is what its default handler answers with, and one
    // thrown after the head has gone out cannot be answered at all
    "throw-string",
    "throw-status",
    "throw-after-send",
    "reject-async",
    // and the rest of the response surface
    "location-back",
    "write-head",
    "remove-header",
    "send-file-options",
    "download-callback",
    "sendstatus-unknown"
];

/**
 * The plan is data, not code: it is drawn once from the generator and then instantiated on both
 * frameworks, so the two applications cannot drift apart through a second draw.
 *
 * @param {() => number} rng
 * @returns {object}
 */
function drawPlan(rng) {
    const pick = (list) => list[Math.floor(rng() * list.length)];
    const chance = (p) => rng() < p;

    // An application shaped so that the registration-time analysis may grant a route the right to
    // skip copying the headers or reading the query: etags off, and no error handler anywhere,
    // which is what the analysis insists on. Nothing may raise either, since without a handler of
    // ours an error would reach express's own page and print a stack that cannot match.
    const skipFriendly = chance(0.3);
    // serving a file raises too, on a range it cannot satisfy, so it is out of this mode as well
    const kinds = skipFriendly ? HANDLER_KINDS.filter((kind) => !RAISES.has(kind)) : HANDLER_KINDS;

    let paramCounter = 0;
    /** A path in path-to-regexp 8 syntax, with parameter names unique inside it. */
    const drawPath = (allowWildcard) => {
        const depth = 1 + Math.floor(rng() * 3);
        const parts = [];
        for (let i = 0; i < depth; i++) {
            const roll = rng();
            if (roll < 0.3) {
                parts.push(":p" + paramCounter++);
            } else if (roll < 0.38) {
                // an optional group, which express 5 spells with braces
                parts.push("{:o" + paramCounter++ + "}");
            } else {
                parts.push(pick(SEGMENTS));
            }
        }
        let p = "/" + parts.join("/");
        if (allowWildcard && chance(0.12)) {
            p += "/*splat" + paramCounter++;
        } else if (chance(0.1)) {
            p += "/";
        }
        return p;
    };

    const drawRoute = (allowWildcard) => ({
        // an error handler between the middleware and the handler, which either answers or hands on
        errorArm: !skipFriendly && chance(0.15) ? pick(["answer", "forward"]) : null,
        // how it is registered: the ordinary way, through app.route(), or as app.all()
        shape: chance(0.12) ? pick(["route", "all"]) : null,
        method: chance(0.75) ? "get" : pick(["post", "put", "delete", "all"]),
        // a quarter of the routes come from the library corpus, whose shapes nothing here invents
        path: chance(0.25) && libraryRoutes.length > 0 ? pick(libraryRoutes) : drawPath(allowWildcard),
        kind: pick(kinds),
        // a middleware in front of the handler, which is where next() bookkeeping goes wrong
        lead: chance(0.3) ? pick(["header", "rewrite", "params", "plain", "method", "baseurl", "leave-router"]) : null,
        id: "r" + paramCounter++
    });

    const settings = {};
    if (chance(0.35)) settings["strict routing"] = chance(0.7);
    if (chance(0.35)) settings["case sensitive routing"] = chance(0.7);
    if (chance(0.25)) settings["query parser"] = pick(["simple", "extended", "fn:query"]);
    if (chance(0.12)) settings["json replacer"] = "fn:replacer";
    // etag off is what lets a chain skip the header copy and the query, so it is worth reaching
    // often rather than rarely
    if (skipFriendly) {
        settings.etag = false;
    } else if (chance(0.4)) {
        settings.etag = pick([false, "strong", "weak", "fn:etag"]);
    }
    if (chance(0.15)) settings["declarative responses"] = false;
    if (chance(0.15)) settings["json spaces"] = 2;
    if (chance(0.1)) settings["json escape"] = true;
    if (chance(0.1)) settings["jsonp callback name"] = "cb";
    if (chance(0.1)) settings["x-powered-by"] = true;
    if (chance(0.1)) settings["subdomain offset"] = 3;
    if (chance(0.3)) settings["trust proxy"] = pick([true, false, 1, 2, "127.0.0.1", "loopback", "fn:proxy"]);
    if (chance(0.5)) settings["view engine"] = "html";
    if (chance(0.3)) settings["view cache"] = chance(0.5);

    // a body parser in front of everything, with a body to match, so req.body is not always absent
    // left out when nothing is there to catch an error: a body parser and a static mount both
    // raise, and with no handler of ours the answer is express own error page, whose stack is its
    // own frames and can never match
    const bodyParser = !skipFriendly && chance(0.3) ? pick(["json", "urlencoded", "text", "raw"]) : null;

    // one or two third party middlewares in front of everything, the way an application installs
    // them. Out of the skip-friendly mode with the rest: an opaque use() is exactly what the usage
    // analysis has to stop at, so a round meant to reach a granted skip would no longer reach one.
    const middlewares = [];
    if (!skipFriendly && chance(0.35)) {
        const count = chance(0.3) ? 2 : 1;
        for (let i = 0; i < count; i++) {
            const name = pick(MIDDLEWARE_NAMES);
            if (middlewares.some((m) => m.name === name)) continue;
            middlewares.push({ name, options: MIDDLEWARE[name].draw(pick, chance) });
        }
    }

    // a static mount: the options are the ones that change what it answers rather than how fast
    const staticMount =
        !skipFriendly && chance(0.35)
            ? {
                  mount: pick(["/files", "/", "/a/files"]),
                  options: {
                      index: pick([false, "index.html"]),
                      dotfiles: pick(["ignore", "allow", "deny"]),
                      redirect: chance(0.5),
                      fallthrough: chance(0.7),
                      extensions: chance(0.3) ? ["html"] : false,
                      maxAge: chance(0.4) ? 3600000 : 0,
                      etag: !chance(0.2),
                      lastModified: !chance(0.2)
                  }
              }
            : null;

    const routers = [];
    const routerCount = Math.floor(rng() * 3);
    for (let i = 0; i < routerCount; i++) {
        const options = {};
        if (chance(0.3)) options.paramCallback = pick(["header", "route", "error"]);
        if (chance(0.2)) options.mountShape = pick(["array", "regex"]);
        if (chance(0.4)) options.strict = chance(0.5);
        if (chance(0.4)) options.caseSensitive = chance(0.5);
        if (chance(0.3)) options.mergeParams = true;
        routers.push({
            mount: drawPath(false),
            options,
            // a router mounted on a router, where the mount paths compose
            nested: chance(0.3)
                ? {
                      mount: drawPath(false),
                      routes: [drawRoute(false)],
                      // a third level, where the mount paths compose twice over
                      deeper: chance(0.4) ? { mount: drawPath(false), routes: [drawRoute(false)] } : null,
                      // and an application mounted inside a router, which swaps req.app on the way
                      subApp: chance(0.3) ? { mount: drawPath(false), routes: [drawRoute(false)] } : null
                  }
                : null,
            routes: Array.from({ length: 1 + Math.floor(rng() * 2) }, () => drawRoute(true))
        });
    }

    // a sub-application, whose routes may exist before or after it is mounted: express reads its
    // routing settings when it builds the router, so that order is visible from outside
    const subApp = chance(0.3)
        ? {
              mount: drawPath(false),
              mountFirst: chance(0.5),
              settings: chance(0.4) ? { "strict routing": chance(0.5) } : {},
              routes: [drawRoute(false)]
          }
        : null;

    const routes = Array.from({ length: 2 + Math.floor(rng() * 5) }, () => drawRoute(true));

    // urls: the registered paths with their parameters filled in, plus noise around them
    const urls = [];
    const everyPath = [
        ...routes.map((r) => r.path),
        ...routers.flatMap((r) => r.routes.map((x) => r.mount + x.path)),
        ...routers
            .filter((r) => r.nested)
            .flatMap((r) => r.nested.routes.map((x) => r.mount + r.nested.mount + x.path)),
        ...(subApp ? subApp.routes.map((x) => subApp.mount + x.path) : [])
    ];
    // three shapes per registered path: as written, with the trailing slash flipped, and in a
    // case the registration did not use. Those three are where the routing flags show themselves
    for (const p of everyPath) {
        const filled = p
            .replace(/\*splat\d+/g, () => PARAM_VALUES[Math.floor(rng() * PARAM_VALUES.length)] + "/x")
            .replace(/\{?:(\w+)\}?/g, () => PARAM_VALUES[Math.floor(rng() * PARAM_VALUES.length)]);
        const flipped = filled.endsWith("/") ? filled.slice(0, -1) : filled + "/";
        urls.push(filled + pick(SUFFIXES), flipped + pick(SUFFIXES), filled.toUpperCase() + pick(SUFFIXES));
        if (chance(0.2)) urls.push(filled.replace("/", "//"));
    }
    urls.push("/" + pick(SEGMENTS) + "/absent", "/", "//", "/a/../b", "/%2e%2e/a");
    // and a handful of corpus paths as requests, which is where its concrete side earns its keep
    for (let i = 0; i < 6; i++) {
        urls.push(pick(LIBRARY_PATHS));
    }

    // a header set per round, so content negotiation and the conditional headers are asked for
    const headers = {};
    if (chance(0.5)) headers.accept = pick(["*/*", "application/json", "text/plain", "text/html;q=0.9, */*;q=0.1"]);
    if (chance(0.3)) headers["accept-language"] = pick(["en", "it, en;q=0.8"]);
    if (chance(0.3)) headers["x-fuzz"] = "probe";
    if (chance(0.2)) headers["x-requested-with"] = "XMLHttpRequest";
    if (chance(0.2)) headers.referer = pick(["http://localhost/from", "/relative", "not a url"]);
    if (chance(0.15)) headers.authorization = "Bearer nothing";
    if (chance(0.2)) headers.cookie = "fuzz=earlier";
    if (chance(0.35)) headers["x-forwarded-for"] = pick(["203.0.113.9", "203.0.113.9, 198.51.100.2", "::1"]);
    if (chance(0.25)) headers["x-forwarded-proto"] = pick(["https", "http", "https, http"]);
    if (chance(0.2)) headers["x-forwarded-host"] = pick(["example.com", "a.b.example.com:8080"]);
    // the rest of the conditional family. if-none-match has its own pass below, made from the etag
    // the answer just carried, but these are asked cold: a fixed date so the two runs send the same
    // one, one far in the past and one far ahead, which land on opposite sides of every mtime here
    if (chance(0.25)) {
        headers["if-modified-since"] = pick(["Thu, 01 Jan 1970 00:00:00 GMT", "Tue, 01 Jan 2999 00:00:00 GMT"]);
    }
    if (chance(0.15)) {
        headers["if-unmodified-since"] = pick(["Thu, 01 Jan 1970 00:00:00 GMT", "Tue, 01 Jan 2999 00:00:00 GMT"]);
    }
    if (chance(0.15)) headers["if-match"] = pick(['"nonsense"', "*", 'W/"weak"']);
    if (chance(0.2)) headers["accept-encoding"] = pick(["gzip", "identity", "gzip, deflate, br", "*"]);
    if (chance(0.15)) headers["accept-charset"] = pick(["utf-8", "iso-8859-1, utf-8;q=0.8"]);
    // what the drawn middleware needs the request to carry, last so it wins over the draws above
    for (const spec of middlewares) {
        const extra = MIDDLEWARE[spec.name].headers;
        if (extra) Object.assign(headers, extra(pick, chance));
    }

    // GET always, since most routes are GET, plus one other verb so the method side is exercised
    // the paths a static mount can answer, asked for whether or not one is mounted: half the
    // point is what happens when nothing serves them
    if (staticMount) {
        const base = staticMount.mount === "/" ? "" : staticMount.mount;
        for (const name of [
            "/a.txt",
            "/b.json",
            "/page",
            "/page.html",
            "/.hidden",
            "/sub/",
            "/sub/deep.txt",
            "/missing.txt",
            "/sub"
        ]) {
            urls.push(base + name);
        }
    }

    // a range now and then, which is the other half of what serving a file means
    if (chance(0.35)) {
        headers.range = pick(["bytes=0-4", "bytes=5-", "bytes=-3", "bytes=0-", "bytes=900-999", "bytes=x-y"]);
    }

    // drawn here rather than looked up when the request goes out, so the shrinker keeps it and the
    // printed case says which body produced the divergence
    const body = bodyParser ? pick(BODIES_FOR[bodyParser]) : null;

    // GET always, since most routes are GET. HEAD always too: it is answered by the GET route with
    // the body dropped, and what a server keeps of the head while dropping it - the length, the
    // etag, the type - is decided somewhere else than the GET path. Drawing it at random meant most
    // rounds never asked. Plus one more verb, so the rest of the table is reached over a run.
    const methods = ["GET", "HEAD", pick(METHODS)];

    return {
        settings,
        routers,
        subApp,
        routes,
        urls,
        headers,
        middlewares,
        bodyParser,
        body,
        staticMount,
        skipFriendly,
        methods: [...new Set(methods)]
    };
}

/**
 * An arrow function with this body, built from text. The declarative compiler reads the source
 * of a handler, so a generated one has to be written out rather than closed over to reach it.
 *
 * @param {string} body
 * @returns {Function}
 */
function arrowFrom(body) {
    return new Function(`return (req, res) => { ${body}; }`)();
}

/**
 * The template engine both arms register. It reports the file it was given, relative to the views
 * directory, so what is compared is the lookup rather than anything the engine invented, and then
 * substitutes the locals so those are compared too.
 *
 * @param {string} filePath
 * @param {Record<string, any>} options
 * @param {(err: any, rendered?: string) => void} callback
 */
function viewEngine(filePath, options, callback) {
    fs.readFile(filePath, "utf8", (err, text) => {
        if (err) {
            return callback(err);
        }
        const relative = path.relative(VIEW_DIR, filePath).split(path.sep).join("/");
        const body = text.replace(/\{\{(\w+)\}\}/g, (whole, key) => String(options[key] ?? ""));
        callback(null, `[${relative}] ${body}`);
    });
}

/** Builds one handler of the kind the plan asked for. */
function makeHandler(route) {
    const id = route.id;
    const text = JSON.stringify(id);
    switch (route.kind) {
        // Written as source and built as an arrow, so the declarative compiler sees a body that
        // mentions nothing but literals and answers it from µWS without running any javascript. A
        // closure over the id would print the name rather than the value and be refused, and so is
        // the shape new Function emits, whose parameter list carries a newline.
        case "lit-send":
            return arrowFrom(`res.send(${text})`);
        case "lit-json":
            return arrowFrom(`res.json({ id: ${text} })`);
        case "lit-status":
            return arrowFrom(`res.status(203).send(${text})`);
        case "lit-header":
            return arrowFrom(`res.set("X-Lit", ${text}).send(${text})`);
        case "lit-end":
            return arrowFrom("res.end()");
        case "lit-type":
            return arrowFrom(`res.type("txt").send(${text})`);
        case "body-echo":
            return (req, res) => res.json({ id, body: req.body ?? null });
        case "jsonp":
            return (req, res) => res.jsonp({ id });
        case "location":
            return (req, res) => res.location("/moved/" + id).send(id);
        case "redirect-relative":
            // a relative target is resolved against the request, which is where the two could
            // disagree about what the request was
            return (req, res) => res.redirect("../sibling");
        case "peer":
            // what the proxy headers were believed to say, which is trust proxy's whole job
            return (req, res) => res.json({ id, ip: req.ip, ips: req.ips, protocol: req.protocol, host: req.hostname });
        case "render":
            return (req, res) => res.render("page", { title: id });
        case "render-ext":
            // named with its extension, which skips the default engine and takes another lookup path
            return (req, res) => res.render("sub/deep.html", { title: id });
        case "render-missing":
            return (req, res) => res.render("nowhere", { title: id });
        case "render-callback":
            // with a callback the error is the caller's to handle, and the response is untouched
            return (req, res, next) =>
                res.render("other", { title: id }, (err, html) => (err ? next(err) : res.type("html").send(html)));
        case "send-file":
            return (req, res) => res.sendFile(path.join(FILE_DIR, "a.txt"));
        case "download":
            // the same read with a Content-Disposition on top, which is its own header to compare
            return (req, res) => res.download(path.join(FILE_DIR, "b.json"), "renamed.json");
        case "negotiate":
            return (req, res) =>
                res.json({
                    id,
                    type: req.accepts(["json", "html", "text"]),
                    language: req.acceptsLanguages(["en", "it"]),
                    fresh: req.fresh
                });
        case "send-json":
            return (req, res) => res.json({ id, params: req.params });
        case "status-send":
            return (req, res) => res.status(201).send(id);
        case "send-status":
            return (req, res) => res.sendStatus(202);
        case "redirect":
            return (req, res) => res.redirect(302, "/somewhere/" + id);
        case "set-header":
            return (req, res) => res.set("X-Fuzz", id).set("Vary", "Accept").send(id);
        case "type-send":
            return (req, res) => res.type("txt").send(id);
        case "end-empty":
            return (req, res) => res.end();
        case "params-echo":
            return (req, res) => res.json({ id, params: req.params, baseUrl: req.baseUrl });
        case "query-echo":
            return (req, res) => res.json({ id, query: req.query });
        case "url-echo":
            return (req, res) =>
                res.json({ id, url: req.url, originalUrl: req.originalUrl, path: req.path, baseUrl: req.baseUrl });
        case "async-send":
            return async (req, res) => {
                await Promise.resolve();
                res.send(id);
            };
        case "throw":
            return () => {
                throw new Error("thrown by " + id);
            };
        case "next-error":
            return (req, res, next) => next(new Error("passed by " + id));
        case "next-route":
            return (req, res, next) => next("route");
        case "next-router":
            return (req, res, next) => next("router");
        case "cookie":
            return (req, res) => res.cookie("fuzz", id, { path: "/", sameSite: "lax" }).send(id);
        case "append":
            // two values under one name, which is a different code path from setting it once
            return (req, res) => res.append("Vary", "Accept").append("Vary", "Accept-Language").send(id);
        case "attachment":
            return (req, res) => res.attachment("report.json").send(id);
        case "attachment-odd-name":
            // a name that has to be quoted and has a quote and a backslash to escape inside it.
            //
            // Deliberately ASCII. A non-ascii one is not comparable: express hands the value to
            // node, whose header block turns the character into U+FFFD and then writes it as
            // latin1, so a filename with an accent leaves express as one corrupt byte. µWS writes
            // the string as utf-8, so the same filename leaves this one intact. Comparing them
            // reported a divergence on every round and the only way to match would be to corrupt
            // the name too, which is not worth being bug-compatible about.
            return (req, res) => res.attachment('re"port\\v1.json').send(id);
        case "clear-cookie":
            return (req, res) => res.cookie("a", id).clearCookie("b", { path: "/x" }).send(id);
        case "cookie-options":
            return (req, res) =>
                res
                    .cookie("opt", id, {
                        maxAge: 3600000,
                        httpOnly: true,
                        secure: true,
                        sameSite: "strict",
                        path: "/x",
                        domain: "example.com"
                    })
                    .send(id);
        case "cookie-signed":
            // express needs a secret for this, and without one both must fail the same way
            return (req, res) => res.cookie("s", id, { signed: true }).send(id);
        case "set-array":
            return (req, res) => res.set("Vary", ["Accept", "Accept-Language"]).send(id);
        case "json-scalar":
            return (req, res) => res.json(null);
        case "json-array":
            return (req, res) => res.json([1, "two", null, { three: true }]);
        case "send-buffer":
            return (req, res) => res.send(Buffer.from("raw bytes " + id));
        case "send-number":
            // a number is a status code in express 4 and a body in express 5, so this pins which
            return (req, res) => res.send(204);
        case "no-content":
            // a status that must carry no body, whatever was handed to send
            return (req, res) => res.status(204).send(id);
        case "write-chunks":
            // written in pieces rather than handed over whole, which is the chunked framing path
            // and the one place a length is not known when the head goes out
            return (req, res) => {
                res.type("txt");
                res.write("first ");
                res.write(id);
                res.end(" last");
            };
        case "write-then-status":
            // a status set after the first write is too late, and both must agree on what happens
            return (req, res) => {
                res.write("out");
                try {
                    res.status(503);
                } catch {
                    // whichever refuses it, the answer is what is compared
                }
                res.end();
            };
        case "type-odd":
            return (req, res) => res.type(".html").send(id);
        case "location-encoded":
            // the encoding rules for a Location are their own, and these are the characters they
            // disagree about
            return (req, res) => res.location("/a b/caffè?q=1&r=2#f").send(id);
        case "redirect-permanent":
            return (req, res) => res.redirect(301, "/moved/" + id);
        case "vary":
            return (req, res) => res.vary("Accept-Language").vary("X-Fuzz").send(id);
        case "links":
            return (req, res) => res.links({ next: "/next/" + id, last: "/last/" + id }).send(id);
        // Everything the request says about itself, which is decided by the header block and the
        // path and by nothing this file writes. req.ip is left out unless trust proxy is on: the
        // socket address is the loopback one either server happened to accept on, and the two
        // spell it differently. The peer kind above covers it under the settings that make it a
        // function of the headers.
        case "req-echo":
            return (req, res) =>
                res.json({
                    id,
                    xhr: req.xhr,
                    fresh: req.fresh,
                    stale: req.stale,
                    protocol: req.protocol,
                    secure: req.secure,
                    hostname: req.hostname,
                    subdomains: req.subdomains,
                    route: req.route ? { path: String(req.route.path), methods: req.route.methods } : null
                });
        case "req-range":
            // parsed against a size the header knows nothing about, so an unsatisfiable range and
            // a malformed one are both reachable. The array carries its type on a property, which
            // JSON drops, so it is written out
            return (req, res) => {
                const parsed = req.range(24);
                res.json({
                    id,
                    ranges: parsed === undefined ? "none" : parsed,
                    type: typeof parsed === "object" ? parsed.type : parsed
                });
            };
        case "req-types":
            return (req, res) =>
                res.json({
                    id,
                    is: req.is("json"),
                    isAny: req.is(["html", "text/*", "application/*"]),
                    accepts: req.accepts(),
                    charsets: req.acceptsCharsets(["utf-8", "iso-8859-1"]),
                    encodings: req.acceptsEncodings(["gzip", "identity"]),
                    header: req.get("x-fuzz") ?? null,
                    referrer: req.get("referrer") ?? null
                });
        // a string is what a throw often is in the wild, and it has no message for a handler to
        // print: express hands it on as it is
        case "throw-string":
            return () => {
                throw "a string thrown by " + id;
            };
        case "throw-status":
            return () => {
                const err = new Error("status carrying error from " + id);
                err.status = 429;
                err.expose = true;
                throw err;
            };
        case "throw-after-send":
            // the head has gone out, so nothing can answer this one: what is compared is what each
            // does with a body that is already on the wire
            return (req, res) => {
                res.send(id);
                throw new Error("too late from " + id);
            };
        case "reject-async":
            return async () => {
                await Promise.resolve();
                throw new Error("rejected by " + id);
            };
        case "location-back":
            // "back" reads the Referer, and with none it is "/", which is two paths through the
            // same method
            return (req, res) => res.location("back").status(204).end();
        case "write-head":
            // node's own method, which express does not override. Every framework that renders a
            // page builds its response with it, and it took the integrations suite to find that
            // this one was setting headers the way res.set does
            return (req, res) => {
                res.writeHead(207, { "Content-Type": "text/plain", "X-Written": id });
                res.end("head " + id);
            };
        case "remove-header":
            return (req, res) => {
                res.set("X-Gone", id);
                res.set("X-Kept", id);
                res.removeHeader("X-Gone");
                res.send(id);
            };
        case "send-file-options":
            // the options branch of sendFile: a root to resolve against, headers of its own, and
            // a dotfile rule that has to refuse the path it is given. The callback has to answer:
            // one that swallows the error leaves the request open, and the comparison would only
            // ever see the timeout
            return (req, res) =>
                res.sendFile(".hidden", { root: FILE_DIR, dotfiles: "deny", headers: { "X-Sent": id } }, (err) => {
                    if (err) res.status(403).send("refused " + id);
                });
        case "download-callback":
            // with a callback the failure is the caller's, and the response is left alone
            return (req, res) =>
                res.download(path.join(FILE_DIR, "missing.txt"), "gone.txt", (err) => {
                    if (err) res.status(410).send("gone " + id);
                });
        case "sendstatus-unknown":
            // a code statuses has no message for, which is where express writes the number itself
            return (req, res) => res.sendStatus(499);
        case "format":
            return (req, res) =>
                res.format({
                    "text/plain": () => res.send("plain " + id),
                    "application/json": () => res.json({ id }),
                    default: () => res.send("default " + id)
                });
        default:
            return (req, res) => res.send(id);
    }
}

/** The optional middleware in front of a handler. */
function makeLead(route) {
    switch (route.lead) {
        case "header":
            return (req, res, next) => {
                res.set("X-Lead", route.id);
                next();
            };
        case "rewrite":
            return (req, res, next) => {
                req.url = req.url.replace(/^\/+/, "/");
                next();
            };
        case "params":
            return (req, res, next) => {
                res.set("X-Params", String(Object.keys(req.params).length));
                next();
            };
        case "method":
            // what method-override does, and express reads req.method again at every layer, so
            // the route that answers after this is the one for the new verb
            return (req, res, next) => {
                if (req.method === "POST") req.method = "DELETE";
                else if (req.method === "GET") req.method = "HEAD";
                next();
            };
        case "baseurl":
            // assigning it changes what reads back and not what the routing matches, which is a
            // difference only a handler after this one can see
            return (req, res, next) => {
                req.baseUrl = "/assigned";
                next();
            };
        case "leave-router":
            // out of this router entirely, which is not the same hop as leaving the route
            return (req, res, next) => next("router");
        default:
            return (req, res, next) => next();
    }
}

// Settings whose value is a function, which the plan cannot carry as data. It holds the name and
// this holds the function, so a drawn plan still prints as source and still shrinks.
const SETTING_FUNCTIONS = {
    "fn:etag": () => '"fixed-by-the-application"',
    "fn:query": (raw) => ({ raw, length: raw.length }),
    // one hop of proxy trusted, written the way an application writes it rather than as a count
    "fn:proxy": (address, hop) => hop < 1,
    "fn:replacer": (key, value) => (key === "id" ? "[" + value + "]" : value)
};

/** @param {any} value a setting as the plan carries it @returns {any} what express is given */
function settingValue(value) {
    return typeof value === "string" && value.startsWith("fn:") ? SETTING_FUNCTIONS[value] : value;
}

/**
 * The body parser the plan asked for, from the framework being instantiated rather than from a
 * fixed one: each has to parse with its own.
 *
 * @param {any} factory
 * @param {string} kind
 * @returns {Function}
 */
function express_bodyParser(factory, kind) {
    if (kind === "json") return factory.json();
    if (kind === "urlencoded") return factory.urlencoded({ extended: true });
    if (kind === "text") return factory.text();
    return factory.raw();
}

/** Registers a plan on a framework and starts it. Returns the app and how to stop it. */
async function instantiate(plan, factory, port, generic) {
    const app = factory();
    // The reference arm of a --self run: the same framework with its optimizer off, so every
    // request walks the ordinary chain. One setting is enough, a compiled response needs a native
    // registration to hang on and goes with it. Set before the plan's own, which never name it, so
    // a plan cannot turn the optimizer back on for the arm that is meant to be without it.
    if (generic) {
        app.set("native routes", false);
    }
    for (const [key, value] of Object.entries(plan.settings)) app.set(key, settingValue(value));
    // registered on every plan: an engine costs nothing until something renders, and a mounted
    // application inherits it, which is part of what this is here to compare
    app.set("views", VIEW_DIR);
    app.engine("html", viewEngine);
    // the same instance is not shared between the arms: each gets one of its own, built from the
    // plan's options, since a middleware that keeps state would otherwise carry it across
    for (const spec of plan.middlewares ?? []) {
        app.use(MIDDLEWARE[spec.name].build(spec.options));
    }
    if (plan.bodyParser) {
        // Fulmine reads a body only for POST, PUT, PATCH and QUERY unless told otherwise, which
        // the readme states as a deliberate difference: express reads one whenever the request
        // carries it. Saying so here compares the two on behaviour rather than rediscovering the
        // difference every time a body rides on a DELETE. Express ignores the setting.
        app.set("body methods", ["POST", "PUT", "PATCH", "QUERY", "DELETE", "OPTIONS"]);
        app.use(express_bodyParser(factory, plan.bodyParser));
    }
    if (plan.staticMount) {
        app.use(plan.staticMount.mount, factory.static(FILE_DIR, { ...plan.staticMount.options }));
    }

    const addRoute = (target, route) => {
        const handlers = route.lead ? [makeLead(route), makeHandler(route)] : [];
        handlers.push(makeHandler(route));
        if (route.errorArm) {
            // express only reaches a four argument handler through an error, so this one sits
            // after the handler and answers what the handler threw, or hands it further on
            handlers.push(
                route.errorArm === "answer"
                    ? (err, req, res, next) => res.status(418).send("caught " + err.message)
                    : (err, req, res, next) => next(err)
            );
        }
        target[route.method](route.path, ...handlers);
    };

    /** The mount path as the plan asked for it: one string, several, or a RegExp. */
    const mountPath = (spec) => {
        if (spec.options.mountShape === "array") return [spec.mount, spec.mount + "/alias"];
        if (spec.options.mountShape === "regex") {
            return new RegExp("^" + spec.mount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        }
        return spec.mount;
    };

    for (const spec of plan.routers) {
        // a copy per instantiation: fulmine's Router rewrites its options object in place, and a
        // shared one would reach express already rewritten and be ignored
        // paramCallback and mountShape belong to the plan and not to Router: the first is set up
        // below, the second is read off the spec by mountPath
        const routerOptions = { ...spec.options };
        const paramCallback = routerOptions.paramCallback;
        delete routerOptions.paramCallback;
        delete routerOptions.mountShape;
        const router = factory.Router(routerOptions);
        if (paramCallback) {
            // express calls this once per value and not once per request, and what it writes into
            // req.params has to survive the rest of the chain. The other two are the ways out of
            // one: leaving the route before it runs, and failing the value, which is what a
            // callback that looks an id up in a database does when it finds nothing
            router.param("p0", (req, res, next, value) => {
                res.set("X-Param-Seen", String(value).slice(0, 20));
                if (paramCallback === "route") return next("route");
                if (paramCallback === "error") return next(new Error("param p0 refused: " + value));
                next();
            });
        }
        for (const route of spec.routes) addRoute(router, route);
        if (spec.nested) {
            const nested = factory.Router();
            for (const route of spec.nested.routes) addRoute(nested, route);
            if (spec.nested.deeper) {
                const deeper = factory.Router();
                for (const route of spec.nested.deeper.routes) addRoute(deeper, route);
                nested.use(spec.nested.deeper.mount, deeper);
            }
            if (spec.nested.subApp) {
                const inner = factory();
                for (const route of spec.nested.subApp.routes) addRoute(inner, route);
                nested.use(spec.nested.subApp.mount, inner);
            }
            router.use(spec.nested.mount, nested);
        }
        app.use(mountPath(spec), router);
    }

    if (plan.subApp) {
        const sub = factory();
        for (const [key, value] of Object.entries(plan.subApp.settings)) sub.set(key, settingValue(value));
        if (plan.subApp.mountFirst) app.use(plan.subApp.mount, sub);
        for (const route of plan.subApp.routes) addRoute(sub, route);
        if (!plan.subApp.mountFirst) app.use(plan.subApp.mount, sub);
    }

    for (const route of plan.routes) {
        if (route.shape === "route") {
            // app.route() hangs several verbs off one path, which is a different layer arrangement
            app.route(route.path)
                .get(makeHandler(route))
                .post(makeHandler({ ...route, id: route.id + "-post" }));
        } else if (route.shape === "all") {
            app.all(route.path, makeHandler(route));
        } else {
            addRoute(app, route);
        }
    }

    app.use((req, res) => res.status(404).send("no route"));
    if (!plan.skipFriendly) {
        // an error handler of our own, because express's default one prints a stack that cannot
        // match. Left out when the plan wants the analysis to grant a skip, which it refuses to do
        // while any error handler exists
        app.use((err, req, res, next) => res.status(500).send("error: " + err.message));
    }

    const server = await new Promise((resolve) => {
        const s = app.listen(port, () => resolve(s));
    });
    return {
        stop: () => (typeof app.close === "function" ? app.close() : new Promise((r) => server.close(r)))
    };
}

// The default error page carries the stack of whoever raised, and those frames belong to each
// project: nothing about them can match. The message above the first line break is compared, the
// rest is dropped, which is what the comparison tests do with the same page.
const DEFAULT_ERROR_PAGE = /<pre>([^]*?)<br>[^]*<\/pre>/;

/** @param {string} body @returns {string} */
function withoutStack(body) {
    const matched = DEFAULT_ERROR_PAGE.exec(body);
    return matched ? body.replace(matched[0], "<pre>" + matched[1] + "<br>(stack)</pre>") : body;
}

/** What is compared: the status, the headers worth comparing, and the body. */
async function answerOf(port, url, method, headers, conditional, body) {
    const sent = conditional ? { ...headers, "if-none-match": conditional } : { ...headers };
    if (body) {
        sent["content-type"] = body.type;
    }
    const res = await fetch("http://localhost:" + port + url, {
        method,
        headers: sent,
        body: body && method !== "GET" && method !== "HEAD" ? body.text : undefined,
        signal: AbortSignal.timeout(5000),
        redirect: "manual"
    });
    const parts = [String(res.status)];
    for (const name of [...COMPARED_HEADERS, ...MIDDLEWARE_HEADERS]) {
        const value = name === "set-cookie" ? res.headers.getSetCookie().join(" | ") : res.headers.get(name);
        if (value !== null && value !== "")
            parts.push(`${name}: ${value.replace(/\d{2}:\d{2}:\d{2} GMT/g, "xx:xx:xx GMT")}`);
    }
    for (const name of PRESENCE_ONLY_HEADERS) {
        if (res.headers.has(name)) parts.push(`${name}: present`);
    }
    parts.push(JSON.stringify(withoutStack(await res.text())));
    return { line: parts.join(" | "), etag: res.headers.get("etag") };
}

let nextPort = 15000;

/**
 * Runs a plan on both frameworks and returns the requests they answered differently.
 *
 * @param {object} plan
 * @param {boolean} stopAtFirst
 * @returns {Promise<{divergences: object[], checked: number}>}
 */
async function runPlan(plan, stopAtFirst) {
    const portA = nextPort++;
    const portB = nextPort++;
    let a, b;
    try {
        // in a --self run the reference is this framework with its optimizer off, so what a
        // divergence reports is the optimizer disagreeing with the chain it is meant to stand in for
        a = SELF ? await instantiate(plan, fulmine, portA, true) : await instantiate(plan, realExpress, portA, false);
    } catch (err) {
        // a path express itself refuses is not a bug in ours
        return { divergences: [], checked: 0, skipped: String(err.message) };
    }
    try {
        b = await instantiate(plan, fulmine, portB);
    } catch (err) {
        await a.stop();
        return {
            divergences: [
                { url: "(registration)", method: "-", express: "registered", fulmine: "threw: " + err.message }
            ],
            checked: 0
        };
    }

    const divergences = [];
    let checked = 0;
    for (const url of plan.urls) {
        for (const method of plan.methods) {
            let ra, rb;
            try {
                const body = plan.body ?? null;
                [ra, rb] = await Promise.all([
                    answerOf(portA, url, method, plan.headers, undefined, body),
                    answerOf(portB, url, method, plan.headers, undefined, body)
                ]);
            } catch {
                continue; // a url fetch itself refuses to build is not a comparison
            }
            checked++;
            if (ra.line !== rb.line) {
                divergences.push({ url, method, express: ra.line, fulmine: rb.line });
                if (stopAtFirst) break;
            } else if (ra.etag && ra.etag === rb.etag) {
                // asked again with the validator both just sent, which is the only way here to a
                // 304 and to the headers express strips from one
                checked++;
                const [ca, cb] = await Promise.all([
                    answerOf(portA, url, method, plan.headers, ra.etag),
                    answerOf(portB, url, method, plan.headers, rb.etag)
                ]);
                if (ca.line !== cb.line) {
                    divergences.push({
                        url,
                        method,
                        conditional: true,
                        express: ca.line,
                        fulmine: cb.line
                    });
                    if (stopAtFirst) break;
                }
            }
        }
        if (stopAtFirst && divergences.length) break;
    }

    await a.stop();
    await b.stop();
    await new Promise((r) => setTimeout(r, 20));
    return { divergences, checked };
}

/**
 * Whether a reduced plan still shows the same disagreement on the same request. The pair of status
 * codes has to match, not merely some disagreement: without that the shrink wanders off to another
 * bug, and reports a two line case that does not produce the answers printed above it.
 */
async function stillFails(plan, target) {
    const probe = { ...plan, urls: [target.url], methods: [target.method] };
    const { divergences } = await runPlan(probe, true);
    if (!divergences.length) {
        return false;
    }
    const statusOf = (answer) => answer.slice(0, answer.indexOf(" "));
    const found = divergences[0];
    return statusOf(found.express) === statusOf(target.express) && statusOf(found.fulmine) === statusOf(target.fulmine);
}

/**
 * Drops everything the divergence does not need. What comes back is small enough to read, and
 * usually small enough to paste into a test as it stands.
 */
async function shrink(plan, target) {
    let current = { ...plan, urls: [target.url], methods: [target.method] };

    const tryWithout = async (candidate) => ((await stillFails(candidate, target)) ? candidate : null);

    // routes first, since there are the most of them
    for (let i = current.routes.length - 1; i >= 0; i--) {
        const candidate = { ...current, routes: current.routes.filter((_, j) => j !== i) };
        current = (await tryWithout(candidate)) ?? current;
    }
    for (let i = current.routers.length - 1; i >= 0; i--) {
        const candidate = { ...current, routers: current.routers.filter((_, j) => j !== i) };
        current = (await tryWithout(candidate)) ?? current;
    }
    if (current.subApp) {
        current = (await tryWithout({ ...current, subApp: null })) ?? current;
    }
    for (let i = (current.middlewares ?? []).length - 1; i >= 0; i--) {
        const candidate = { ...current, middlewares: current.middlewares.filter((_, j) => j !== i) };
        current = (await tryWithout(candidate)) ?? current;
    }
    for (const key of Object.keys(current.settings)) {
        const settings = { ...current.settings };
        delete settings[key];
        current = (await tryWithout({ ...current, settings })) ?? current;
    }
    for (const spec of current.routers) {
        for (const key of Object.keys(spec.options)) {
            const options = { ...spec.options };
            delete options[key];
            const candidate = { ...current, routers: current.routers.map((r) => (r === spec ? { ...r, options } : r)) };
            current = (await tryWithout(candidate)) ?? current;
        }
    }
    return current;
}

/** The shrunk plan as the source it stands for. */
function planToSource(plan, target) {
    const lines = ["const app = express();"];
    for (const [key, value] of Object.entries(plan.settings))
        lines.push(`app.set(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
    // what is registered before any route, and what the request carries: leaving these out made a
    // case look smaller than it was, since the answer often comes from here rather than from a route
    for (const spec of plan.middlewares ?? [])
        lines.push(`app.use(${spec.name}(${JSON.stringify(spec.options)}));  // the npm package, on both arms`);
    if (plan.bodyParser) lines.push(`app.use(express.${plan.bodyParser}());`);
    if (plan.body) lines.push(`// request body: ${JSON.stringify(plan.body)}`);
    if (plan.staticMount) {
        const options = JSON.stringify(plan.staticMount.options);
        lines.push(`app.use(${JSON.stringify(plan.staticMount.mount)}, express.static(dir, ${options}));`);
    }
    if (plan.skipFriendly) lines.push("// no error handler anywhere, so the usage analysis may grant a skip");
    if (plan.headers && Object.keys(plan.headers).length > 0) {
        lines.push(`// request headers: ${JSON.stringify(plan.headers)}`);
    }
    for (const [i, spec] of plan.routers.entries()) {
        lines.push(`const router${i} = express.Router(${JSON.stringify(spec.options)});`);
        for (const route of spec.routes)
            lines.push(`router${i}.${route.method}(${JSON.stringify(route.path)}, ${route.kind});`);
        if (spec.nested) {
            lines.push(`const nested${i} = express.Router();`);
            for (const route of spec.nested.routes)
                lines.push(`nested${i}.${route.method}(${JSON.stringify(route.path)}, ${route.kind});`);
            // the third level and the application below it, which instantiate() builds and this
            // used to leave out: a case printed without them cannot be reproduced from the print
            if (spec.nested.deeper) {
                lines.push(`const deeper${i} = express.Router();`);
                for (const route of spec.nested.deeper.routes)
                    lines.push(`deeper${i}.${route.method}(${JSON.stringify(route.path)}, ${route.kind});`);
                lines.push(`nested${i}.use(${JSON.stringify(spec.nested.deeper.mount)}, deeper${i});`);
            }
            if (spec.nested.subApp) {
                lines.push(`const inner${i} = express();`);
                for (const route of spec.nested.subApp.routes)
                    lines.push(`inner${i}.${route.method}(${JSON.stringify(route.path)}, ${route.kind});`);
                lines.push(`nested${i}.use(${JSON.stringify(spec.nested.subApp.mount)}, inner${i});`);
            }
            lines.push(`router${i}.use(${JSON.stringify(spec.nested.mount)}, nested${i});`);
        }
        lines.push(`app.use(${JSON.stringify(spec.mount)}, router${i});`);
    }
    if (plan.subApp) {
        lines.push(`const sub = express();  // mounted ${plan.subApp.mountFirst ? "before" : "after"} its routes`);
        for (const [key, value] of Object.entries(plan.subApp.settings))
            lines.push(`sub.set(${JSON.stringify(key)}, ${JSON.stringify(value)});`);
        for (const route of plan.subApp.routes)
            lines.push(`sub.${route.method}(${JSON.stringify(route.path)}, ${route.kind});`);
        lines.push(`app.use(${JSON.stringify(plan.subApp.mount)}, sub);`);
    }
    for (const route of plan.routes) lines.push(`app.${route.method}(${JSON.stringify(route.path)}, ${route.kind});`);
    lines.push(`// then: ${target.method} ${target.url}`);
    return lines.join("\n");
}

async function main() {
    const argv = process.argv.slice(2);
    const flag = (name, fallback) => {
        const at = argv.indexOf("--" + name);
        return at === -1 ? fallback : Number(argv[at + 1]);
    };
    const rounds = flag("rounds", 200);
    const baseSeed = flag("seed", (Date.now() ^ (process.pid << 16)) >>> 0);
    const keepGoing = argv.includes("--keep-going");

    // Registration parity first: a pattern one framework takes and the other refuses is a
    // divergence before any request is made, and it also decides which shapes the rounds can use.
    const refusedByFulmine = [];
    for (const candidate of LIBRARY_PATHS) {
        const accepts = (factory) => {
            try {
                factory.Router().get(candidate, (req, res) => res.end());
                return true;
            } catch {
                return false;
            }
        };
        const byExpress = accepts(realExpress);
        if (byExpress) {
            libraryRoutes.push(candidate);
            if (!accepts(fulmine)) {
                refusedByFulmine.push(candidate);
            }
        }
    }
    console.log(
        `${libraryRoutes.length} of ${LIBRARY_PATHS.length} library patterns are valid routes` +
            (refusedByFulmine.length
                ? `, ${refusedByFulmine.length} refused by fulmine: ${refusedByFulmine.join(" ")}`
                : "")
    );

    writeFiles();
    console.log(`fuzzing ${rounds} rounds from seed ${baseSeed}`);
    let checked = 0;
    let found = 0;

    for (let round = 0; round < rounds; round++) {
        const seed = (baseSeed + round) >>> 0;
        const plan = drawPlan(mulberry32(seed));
        const result = await runPlan(plan, false);
        checked += result.checked;
        if (!result.divergences.length) {
            if (round % 25 === 24) console.log(`  ${round + 1} rounds, ${checked} requests, no divergence`);
            continue;
        }

        found += result.divergences.length;
        const target = result.divergences[0];
        console.log(`\n=== divergence in round ${round}, seed ${seed} (replay: --seed ${seed} --rounds 1)`);
        console.log(`${target.method} ${target.url}${target.conditional ? " asked again with if-none-match" : ""}`);
        console.log(`  ${LEFT}: ${target.express}`);
        console.log(`  ${RIGHT}: ${target.fulmine}`);
        if (result.divergences.length > 1)
            console.log(`  (${result.divergences.length} requests disagree in this round)`);

        console.log("\nshrinking...");
        const small = await shrink(plan, target);
        console.log("\n" + planToSource(small, target));
        // what the shrunk plan answers on its own, since the two lines above belong to the whole
        // round: a reader comparing them against this source would be reading two applications
        const confirmed = await runPlan(small, true);
        if (confirmed.divergences.length) {
            console.log(`  ${LEFT}: ${confirmed.divergences[0].express}`);
            console.log(`  ${RIGHT}: ${confirmed.divergences[0].fulmine}`);
        } else {
            console.log("  (this shrunk plan does not disagree on its own: it needs the round around it)");
        }

        if (!keepGoing) {
            console.log(`\n${checked} requests compared before this`);
            process.exit(1);
        }
    }

    console.log(`\n${rounds} rounds, ${checked} requests compared, ${found} divergences`);
    process.exit(found ? 1 : 0);
}

main();
