// Unit tests for src/utils.js.
//
// These exist because the rest of the suite cannot reach this code. Every other test runs the same
// file against Express and against Fulmine and compares what came out, which is the right way to
// check behaviour a client can see, and no way at all to check a pure function's edge cases: to
// exercise escapeHtml's ampersand branch through a request you would have to find a response that
// happens to contain one.
//
// Measured before writing them, from the nyc report: deprecated() was never called at all, and
// escapeHtml, patternToRegex, compileTrust, isRangeFresh, acceptParams and decode were each
// entered without their branches being taken.

const test = require("node:test");
const assert = require("node:assert");
const { Stats } = require("node:fs");

const {
    removeDuplicateSlashes,
    patternToRegex,
    needsConversionToRegex,
    canBeOptimized,
    normalizeType,
    stringify,
    compileTrust,
    deprecated,
    findIndexStartingFrom,
    decode,
    containsDotFile,
    parseTokenList,
    parseHttpDate,
    isPreconditionFailure,
    createETagGenerator,
    isRangeFresh,
    escapeHtml,
    withDefaultCharset,
    withUtf8Charset,
    fastQueryParse,
    NullObject,
    entityTag,
    statTag,
    contentTypeFor,
    memoizeByString,
    pathsCanOverlap,
    EMPTY_REGEX
} = require("../../src/utils.js");

test("escapeHtml escapes the five characters that would otherwise be markup", () => {
    assert.strictEqual(escapeHtml("<script>"), "&lt;script&gt;");
    assert.strictEqual(escapeHtml("a & b"), "a &amp; b");
    assert.strictEqual(escapeHtml('say "hi"'), "say &quot;hi&quot;");
    assert.strictEqual(escapeHtml("it's"), "it&#39;s");
    assert.strictEqual(
        escapeHtml("<a href=\"x\" title='y'>&</a>"),
        "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;"
    );
});

test("escapeHtml leaves everything else alone", () => {
    assert.strictEqual(escapeHtml(""), "");
    assert.strictEqual(escapeHtml("plain text"), "plain text");
    // not ASCII, and not one of the five: it comes through untouched rather than being encoded
    assert.strictEqual(escapeHtml("caffè ☕"), "caffè ☕");
});

test("removeDuplicateSlashes collapses runs but keeps a single one", () => {
    assert.strictEqual(removeDuplicateSlashes("//a///b"), "/a/b");
    assert.strictEqual(removeDuplicateSlashes("/a/b"), "/a/b");
    assert.strictEqual(removeDuplicateSlashes("/"), "/");
    assert.strictEqual(removeDuplicateSlashes("////"), "/");
});

test("needsConversionToRegex and canBeOptimized are not opposites", () => {
    assert.strictEqual(needsConversionToRegex("/users/:id"), true);
    assert.strictEqual(canBeOptimized("/users/:id"), false);

    assert.strictEqual(needsConversionToRegex("/users"), false);
    assert.strictEqual(canBeOptimized("/users"), true);

    // a RegExp needs no conversion and cannot be optimized either, which is the case that makes
    // one the negation of the other only by accident
    const pattern = /^\/users$/;
    assert.strictEqual(needsConversionToRegex(pattern), false);
    assert.strictEqual(canBeOptimized(pattern), false);
});

test("patternToRegex compiles the four shapes a path can take", () => {
    assert.ok(patternToRegex("/users/:id").test("/users/42"));
    assert.strictEqual(patternToRegex("/users/:id").exec("/users/42").groups.id, "42");

    // a wildcard takes more than one segment
    assert.ok(patternToRegex("/files/*rest").test("/files/a/b/c"));

    // an optional group
    assert.ok(patternToRegex("/a{/b}").test("/a"));
    assert.ok(patternToRegex("/a{/b}").test("/a/b"));

    // an escaped literal is not an operator
    assert.ok(patternToRegex("/a\\:b").test("/a:b"));
});

test("patternToRegex refuses what it cannot match rather than matching it literally", () => {
    // a route that quietly stops matching is worse than one that fails at startup
    assert.throws(() => patternToRegex("/*"), /Missing parameter name/);
    assert.throws(() => patternToRegex("/:"), /Missing parameter name/);
});

test("patternToRegex hands a RegExp back untouched, and the empty prefix is the shared one", () => {
    const pattern = /^\/x$/;
    assert.strictEqual(patternToRegex(pattern), pattern);
    assert.strictEqual(patternToRegex("", true), EMPTY_REGEX);
});

test("compileTrust turns every accepted spelling into a predicate", () => {
    const own = () => true;
    assert.strictEqual(compileTrust(own), own, "a function is its own answer");

    assert.strictEqual(compileTrust(true)("10.0.0.1", 0), true);

    // a number trusts that many hops and no more
    const twoHops = compileTrust(2);
    assert.strictEqual(twoHops("10.0.0.1", 0), true);
    assert.strictEqual(twoHops("10.0.0.1", 1), true);
    assert.strictEqual(twoHops("10.0.0.1", 2), false);

    // a comma-separated string is a list, whitespace and all
    const list = compileTrust("127.0.0.1, 10.0.0.0/8");
    assert.strictEqual(list("127.0.0.1", 0), true);
    assert.strictEqual(list("10.1.2.3", 0), true);
    assert.strictEqual(list("8.8.8.8", 0), false);

    // false trusts nothing at all
    assert.strictEqual(compileTrust(false)("127.0.0.1", 0), false);
});

test("decode answers rather than throwing on a malformed escape", () => {
    assert.strictEqual(decode("/a%20b"), "/a b");
    assert.strictEqual(decode("/a%ZZ"), -1);
    assert.strictEqual(decode("/plain"), "/plain");
});

test("containsDotFile does not mistake the current directory for one", () => {
    assert.strictEqual(containsDotFile(["a", ".env"]), true);
    assert.strictEqual(containsDotFile(["a", "b"]), false);
    // a single "." is the current directory, not a dotfile
    assert.strictEqual(containsDotFile(["a", ".", "b"]), false);
    assert.strictEqual(containsDotFile([]), false);
});

test("parseTokenList splits and trims", () => {
    assert.deepStrictEqual(parseTokenList('"a", "b"'), ['"a"', '"b"']);
    assert.deepStrictEqual(parseTokenList("a,b"), ["a", "b"]);
    assert.deepStrictEqual(parseTokenList("  a  "), ["a"]);
    assert.deepStrictEqual(parseTokenList(""), []);
});

test("parseHttpDate answers NaN for anything it cannot read", () => {
    assert.strictEqual(parseHttpDate("Wed, 21 Oct 2015 07:28:00 GMT"), Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"));
    assert.ok(Number.isNaN(parseHttpDate("not a date")));
    assert.ok(Number.isNaN(parseHttpDate(undefined)));
    // every comparison against NaN is false, which is the answer a bad date should give
    assert.strictEqual(parseHttpDate(undefined) <= Date.now(), false);
});

test("findIndexStartingFrom resumes rather than restarting", () => {
    const items = ["a", "b", "a", "c"];
    assert.strictEqual(
        findIndexStartingFrom(items, (x) => x === "a"),
        0
    );
    assert.strictEqual(
        findIndexStartingFrom(items, (x) => x === "a", 1),
        2
    );
    assert.strictEqual(
        findIndexStartingFrom(items, (x) => x === "a", 3),
        -1
    );
});

test("acceptParams pulls out the value, the quality and the rest", () => {
    assert.deepStrictEqual(acceptParamsShape("text/html"), { value: "text/html", quality: 1, params: {} });
    assert.deepStrictEqual(acceptParamsShape("text/html;q=0.8"), { value: "text/html", quality: 0.8, params: {} });
    assert.deepStrictEqual(acceptParamsShape("text/html;level=1;q=0.5"), {
        value: "text/html",
        quality: 0.5,
        params: { level: "1" }
    });
});

// normalizeType is the only export that reaches acceptParams, so it is exercised through that
function acceptParamsShape(type) {
    // any, because quality is only present when the type string carried a q parameter and the
    // declared return type does not know it
    const parsed = /** @type {any} */ (normalizeType(type));
    return { value: parsed.value, quality: parsed.quality ?? 1, params: parsed.params };
}

test("normalizeType takes an extension or a full media type", () => {
    assert.strictEqual(normalizeType("html").value, "text/html");
    assert.strictEqual(normalizeType("json").value, "application/json");
    assert.strictEqual(normalizeType("text/plain").value, "text/plain");
    // an extension nobody knows is a stream of bytes rather than an error
    assert.strictEqual(normalizeType("not-a-real-extension").value, "application/octet-stream");
});

test("stringify escapes only when asked, and only the three that close a tag", () => {
    assert.strictEqual(stringify({ a: "<b>" }), '{"a":"<b>"}');
    assert.strictEqual(stringify({ a: "<b>" }, undefined, undefined, true), '{"a":"\\u003cb\\u003e"}');
    assert.strictEqual(stringify({ a: "x & y" }, undefined, undefined, true), '{"a":"x \\u0026 y"}');
    // the escaping is of the JSON text, so a quote is still the JSON quote
    assert.strictEqual(stringify("plain", undefined, undefined, true), '"plain"');
});

test("stringify honours the replacer and the spacing", () => {
    assert.strictEqual(stringify({ a: 1, b: 2 }, ["a"]), '{"a":1}');
    assert.strictEqual(stringify({ a: 1 }, undefined, 2), '{\n  "a": 1\n}');
});

test("createETagGenerator takes a body or a stat, and weak differs from strong", () => {
    const weak = createETagGenerator({ weak: true });
    const strong = createETagGenerator({ weak: false });

    assert.match(weak("hello"), /^W\//);
    assert.doesNotMatch(strong("hello"), /^W\//);
    // the same body gives the same tag, which is the whole point
    assert.strictEqual(weak("hello"), weak("hello"));
    assert.notStrictEqual(weak("hello"), weak("goodbye"));

    // a Buffer and the string it holds are the same entity
    assert.strictEqual(weak(Buffer.from("hello")), weak("hello"));

    // a stat is tagged from its size and mtime rather than its contents
    const stat = Object.create(Stats.prototype);
    stat.size = 1024;
    stat.mtime = new Date(1700000000000);
    assert.match(weak(stat), /^W\/"400-/);
});

test("isRangeFresh reads If-Range as either an etag or a date", () => {
    const res = (headers) => ({ get: (name) => headers[name.toLowerCase()] });

    // no If-Range at all: nothing to be stale against
    assert.strictEqual(isRangeFresh({ headers: {} }, res({})), true);

    // as an etag
    assert.strictEqual(isRangeFresh({ headers: { "if-range": '"abc"' } }, res({ etag: '"abc"' })), true);
    assert.strictEqual(isRangeFresh({ headers: { "if-range": '"abc"' } }, res({ etag: '"xyz"' })), false);
    assert.strictEqual(isRangeFresh({ headers: { "if-range": '"abc"' } }, res({})), false);

    // as a date, where only an exact match counts: the file must not have been touched since
    const when = "Wed, 21 Oct 2015 07:28:00 GMT";
    assert.strictEqual(isRangeFresh({ headers: { "if-range": when } }, res({ "last-modified": when })), true);
    assert.strictEqual(
        isRangeFresh({ headers: { "if-range": when } }, res({ "last-modified": "Thu, 22 Oct 2015 07:28:00 GMT" })),
        false
    );
});

test("isPreconditionFailure is about If-Match, which is a 412 and not a 304", () => {
    const res = (headers) => ({ get: (name) => headers[name.toLowerCase()] });

    assert.strictEqual(isPreconditionFailure({ headers: {} }, res({})), false);
    assert.strictEqual(isPreconditionFailure({ headers: { "if-match": '"abc"' } }, res({ etag: '"abc"' })), false);
    assert.strictEqual(isPreconditionFailure({ headers: { "if-match": '"abc"' } }, res({ etag: '"xyz"' })), true);
    // "*" asks only that the thing exists, and an etag is the proof that it does
    assert.strictEqual(isPreconditionFailure({ headers: { "if-match": "*" } }, res({ etag: '"abc"' })), false);
    assert.strictEqual(isPreconditionFailure({ headers: { "if-match": "*" } }, res({})), true);
});

test("withDefaultCharset adds the charset a media type implies, and only then", () => {
    assert.strictEqual(withDefaultCharset("text/html"), "text/html; charset=utf-8");
    assert.strictEqual(withDefaultCharset("application/json"), "application/json; charset=utf-8");
    // every type the database gives one, not a list of three: this is the one that was missing
    assert.strictEqual(withDefaultCharset("application/manifest+json"), "application/manifest+json; charset=utf-8");
    // a type with no charset in the database keeps none
    assert.strictEqual(withDefaultCharset("image/png"), "image/png");
    // one that already says something is left alone, whatever it says
    assert.strictEqual(withDefaultCharset("text/html; charset=iso-8859-1"), "text/html; charset=iso-8859-1");
});

test("withUtf8Charset replaces rather than appends, because the body is utf-8 whatever was there", () => {
    assert.strictEqual(withUtf8Charset("text/html; charset=iso-8859-1"), "text/html; charset=utf-8");
    assert.strictEqual(withUtf8Charset("text/plain"), "text/plain; charset=utf-8");
    // already right: the fast path returns the value itself
    assert.strictEqual(withUtf8Charset("text/html; charset=utf-8"), "text/html; charset=utf-8");
    // spacing and case the way a client might have written them
    assert.strictEqual(withUtf8Charset("text/html;charset=ISO-8859-1"), "text/html; charset=utf-8");
});

test("fastQueryParse keeps a null prototype whichever parser it used", () => {
    // the short simple path, through fast-querystring
    const simple = fastQueryParse("a=1&b=2");
    assert.deepStrictEqual({ ...simple }, { a: "1", b: "2" });
    assert.strictEqual(Object.getPrototypeOf(simple), null);

    // the qs path, taken because of the bracket
    const nested = fastQueryParse("a[b]=1");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(nested)), { a: { b: "1" } });
    assert.strictEqual(Object.getPrototypeOf(nested), null);

    // empty
    assert.deepStrictEqual({ ...fastQueryParse("") }, {});
    assert.strictEqual(Object.getPrototypeOf(fastQueryParse("")), null);

    // a key that would otherwise reach Object.prototype
    const polluted = fastQueryParse("__proto__[x]=1");
    assert.strictEqual({}.x, undefined, "Object.prototype must not have been touched");
    assert.strictEqual(Object.getPrototypeOf(polluted), null);
});

test("NullObject instances cannot reach Object.prototype", () => {
    const obj = new NullObject();

    // its prototype is not null: it is NullObject.prototype, which is where the chain then ends.
    // What matters is that Object.prototype is not on the chain at all.
    assert.notStrictEqual(Object.getPrototypeOf(obj), null);
    assert.strictEqual(Object.getPrototypeOf(Object.getPrototypeOf(obj)), null);
    assert.strictEqual(obj instanceof Object, false);
    assert.strictEqual(obj.toString, undefined);
    assert.strictEqual(obj.hasOwnProperty, undefined);

    obj["__proto__"] = { polluted: true };
    assert.strictEqual({}.polluted, undefined);
});

test("deprecated warns once per call site and names the replacement", () => {
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
        deprecated("req.acceptsCharset", "req.acceptsCharsets");
        deprecated("req.acceptsCharset", "req.acceptsCharsets");
    } finally {
        console.warn = realWarn;
    }

    assert.strictEqual(warnings.length, 1, "the same call site warns once, not once per call");
    assert.match(warnings[0], /fulmine\.js deprecated req\.acceptsCharset: Use req\.acceptsCharsets instead at /);
});

// The ETag is computed here rather than by the etag package, because the package allocates a hash
// object per response through crypto.createHash and the one-shot crypto.hash does not: twice as
// fast on a 500 byte body for a string that has to be identical to the character. These tests are
// what "identical" means, and etag is kept as a devDependency to be the thing they compare against,
// so the two cannot drift apart without a test saying so.
test("entityTag answers exactly what the etag package answers", () => {
    const reference = require("etag");
    const bodies = [
        "",
        "a",
        "Hello world",
        "<!DOCTYPE html><html><body>a page</body></html>",
        JSON.stringify({ name: "john", items: [1, 2, 3] }),
        // multibyte, where a string's length in characters is not its length in bytes
        "caffè, naïve, 日本語",
        "x".repeat(10000)
    ];

    for (const body of bodies) {
        const buf = Buffer.from(body);
        assert.strictEqual(entityTag(buf, false), reference(buf), `strong, ${JSON.stringify(body.slice(0, 20))}`);
        assert.strictEqual(
            entityTag(buf, true),
            reference(buf, { weak: true }),
            `weak, ${JSON.stringify(body.slice(0, 20))}`
        );
        // a string is hashed as utf-8 and measured in bytes, as the package does
        assert.strictEqual(entityTag(body, false), reference(body), `string, ${JSON.stringify(body.slice(0, 20))}`);
    }
});

test("statTag answers exactly what the etag package answers for a file", () => {
    const reference = require("etag");
    // not new Stats(): the constructor is private in @types/node, and instanceof only needs
    // the prototype
    const stat = /** @type {any} */ (Object.create(Stats.prototype));
    stat.size = 84508;
    stat.mtime = new Date("2026-08-02T10:00:00.000Z");

    // weak by default for a file, which is the package's own default when given a Stats: the size
    // and mtime say the file changed, not that these exact bytes are the same ones
    assert.strictEqual(statTag(stat, true), reference(stat));
    assert.strictEqual(statTag(stat, false), reference(stat, { weak: false }));

    // an empty file is a size of zero, and not the empty-body hash
    stat.size = 0;
    assert.strictEqual(statTag(stat, true), reference(stat, { weak: true }));
});

test("memoizeByString answers from the cache and starts over rather than growing", () => {
    let calls = 0;
    const memo = memoizeByString((key) => {
        calls++;
        return key.toUpperCase();
    });

    assert.strictEqual(memo("json"), "JSON");
    assert.strictEqual(memo("json"), "JSON");
    assert.strictEqual(calls, 1, "the second ask is answered from the cache");

    // The keys can come from a client, through res.type(req.query.format) or a content-type header,
    // so the cache has a ceiling. Past it everything is dropped rather than the map growing without
    // bound, which is the whole point: a client must not be able to make this hold memory.
    for (let i = 0; i < 600; i++) {
        memo(`type-${i}`);
    }
    calls = 0;
    memo("json");
    assert.strictEqual(calls, 1, "the entry was dropped when the cache started over, so it is worked out again");
    memo("json");
    assert.strictEqual(calls, 1, "and kept again afterwards");
});

test("contentTypeFor names the type an extension stands for, charset included", () => {
    assert.strictEqual(contentTypeFor("json"), "application/json; charset=utf-8");
    assert.strictEqual(contentTypeFor("html"), "text/html; charset=utf-8");
    assert.strictEqual(contentTypeFor("png"), "image/png");
    assert.strictEqual(contentTypeFor("not-an-extension"), "application/octet-stream");
    // asked twice, since the second answer comes from the cache and has to be the same one
    assert.strictEqual(contentTypeFor("json"), "application/json; charset=utf-8");
});

test("pathsCanOverlap is about whether two routes could answer the same request", () => {
    // what decides whether a route inside a mounted router may go to the native router: it may,
    // when nothing registered after it in that router could have answered instead
    assert.strictEqual(pathsCanOverlap("/orders/:id", "/invoices/:id"), false, "different literals");
    assert.strictEqual(pathsCanOverlap("/orders/:id", "/orders/:id/items"), false, "different lengths");
    assert.strictEqual(pathsCanOverlap("/users/:id", "/users/me"), true, "a parameter matches the literal");
    assert.strictEqual(pathsCanOverlap("/users/:id", "/users/:name"), true, "two parameters always can");
    assert.strictEqual(pathsCanOverlap("/a/:b/c", "/a/x/c"), true);
    assert.strictEqual(pathsCanOverlap("/a/:b/c", "/a/x/d"), false, "the last segment settles it");
});
