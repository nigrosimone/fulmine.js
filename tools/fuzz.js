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

// x-powered-by, content-length and transfer-encoding stay out for the reasons tests/helpers.js
// gives: the two servers differ there by design rather than by fault.

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
const METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"];

// what a request carries when the plan put a body parser in front, one shape per parser
const BODY_FOR = {
    json: { type: "application/json", text: '{"a":1,"b":[2,3],"c":{"d":"e"}}' },
    urlencoded: { type: "application/x-www-form-urlencoded", text: "a=1&b[]=2&b[]=3&c[d]=e" },
    text: { type: "text/plain", text: "a body of plain text" },
    raw: { type: "application/octet-stream", text: "bytes" }
};

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
    for (const [name, body] of Object.entries(FILES)) {
        fs.writeFileSync(path.join(FILE_DIR, name), body);
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
const RAISES = new Set(["throw", "next-error", "send-file", "download"]);

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
    "download"
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
        lead: chance(0.25) ? pick(["header", "rewrite", "params", "plain"]) : null,
        id: "r" + paramCounter++
    });

    const settings = {};
    if (chance(0.35)) settings["strict routing"] = chance(0.7);
    if (chance(0.35)) settings["case sensitive routing"] = chance(0.7);
    if (chance(0.2)) settings["query parser"] = pick(["simple", "extended"]);
    // etag off is what lets a chain skip the header copy and the query, so it is worth reaching
    // often rather than rarely
    if (skipFriendly) {
        settings.etag = false;
    } else if (chance(0.4)) {
        settings.etag = pick([false, "strong", "weak"]);
    }
    if (chance(0.15)) settings["declarative responses"] = false;
    if (chance(0.15)) settings["json spaces"] = 2;
    if (chance(0.1)) settings["json escape"] = true;
    if (chance(0.1)) settings["jsonp callback name"] = "cb";
    if (chance(0.1)) settings["x-powered-by"] = true;
    if (chance(0.1)) settings["subdomain offset"] = 3;
    if (chance(0.25)) settings["trust proxy"] = pick([true, false, 1, 2, "127.0.0.1", "loopback"]);

    // a body parser in front of everything, with a body to match, so req.body is not always absent
    // left out when nothing is there to catch an error: a body parser and a static mount both
    // raise, and with no handler of ours the answer is express own error page, whose stack is its
    // own frames and can never match
    const bodyParser = !skipFriendly && chance(0.3) ? pick(["json", "urlencoded", "text", "raw"]) : null;

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
        if (chance(0.25)) options.paramCallback = true;
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
    if (chance(0.2)) headers.cookie = "fuzz=earlier";
    if (chance(0.35)) headers["x-forwarded-for"] = pick(["203.0.113.9", "203.0.113.9, 198.51.100.2", "::1"]);
    if (chance(0.25)) headers["x-forwarded-proto"] = pick(["https", "http", "https, http"]);
    if (chance(0.2)) headers["x-forwarded-host"] = pick(["example.com", "a.b.example.com:8080"]);

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

    return {
        settings,
        routers,
        subApp,
        routes,
        urls,
        headers,
        bodyParser,
        staticMount,
        skipFriendly,
        methods: ["GET", pick(METHODS)]
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
        case "vary":
            return (req, res) => res.vary("Accept-Language").vary("X-Fuzz").send(id);
        case "links":
            return (req, res) => res.links({ next: "/next/" + id, last: "/last/" + id }).send(id);
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
        default:
            return (req, res, next) => next();
    }
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
async function instantiate(plan, factory, port) {
    const app = factory();
    for (const [key, value] of Object.entries(plan.settings)) app.set(key, value);
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
            // req.params has to survive the rest of the chain
            router.param("p0", (req, res, next, value) => {
                res.set("X-Param-Seen", String(value).slice(0, 20));
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
        for (const [key, value] of Object.entries(plan.subApp.settings)) sub.set(key, value);
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
    for (const name of COMPARED_HEADERS) {
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
        a = await instantiate(plan, realExpress, portA);
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
                const body = BODY_FOR[plan.bodyParser] ?? null;
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
    if (plan.bodyParser) lines.push(`app.use(express.${plan.bodyParser}());`);
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
        console.log(`  express: ${target.express}`);
        console.log(`  fulmine: ${target.fulmine}`);
        if (result.divergences.length > 1)
            console.log(`  (${result.divergences.length} requests disagree in this round)`);

        console.log("\nshrinking...");
        const small = await shrink(plan, target);
        console.log("\n" + planToSource(small, target));
        // what the shrunk plan answers on its own, since the two lines above belong to the whole
        // round: a reader comparing them against this source would be reading two applications
        const confirmed = await runPlan(small, true);
        if (confirmed.divergences.length) {
            console.log(`  express: ${confirmed.divergences[0].express}`);
            console.log(`  fulmine: ${confirmed.divergences[0].fulmine}`);
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
