// The vendored parser against the library it was vendored from, over the shapes the fast paths
// branch on. The vendoring changed exactly one thing, the result's prototype, so on every input
// the two must agree entry for entry: any other divergence is a transcription mistake.

const test = require("node:test");
const assert = require("node:assert");

const parseQuery = require("../../src/parse-query.js");
const fqs = require("fast-querystring");

const INPUTS = [
    "",
    "a=1",
    "a=1&b=2",
    "a=1&a=2", // repeated key becomes an array
    "a=1&a=2&a=3", // and grows past two
    "a", // key with no '='
    "a&b", // two of them
    "=1", // empty key with a value still lands
    "=", // empty key, empty value
    "&", // empty pair
    "&&a=1&&", // empty pairs around a real one
    "a=", // empty value
    "a+b=c+d", // '+' means space on both sides
    "a%20b=c%20d", // percent-decoding on both sides
    "%61=%62", // decoded key collides with a plain one
    "a=1=2", // a second '=' belongs to the value
    "a==", // and so does an empty one
    "a=%", // malformed escape falls back to the raw text
    "a=%zz", // so does an undecodable one
    "%=1", // malformed escape in the key
    "a[]=1&a[]=2", // brackets are just characters here
    "a=1&B=2&b=3", // case matters
    "constructor=1&toString=2", // prototype names are plain keys on the bare result
    "a=+", // a value that is only a space
    "+=a" // a key that is only a space
];

test("the vendored parser agrees with fast-querystring on every branching shape", () => {
    for (const input of INPUTS) {
        assert.deepEqual({ ...parseQuery(input) }, { ...fqs.parse(input) }, JSON.stringify(input));
    }
});

test("a non-string input answers an empty bare object", () => {
    for (const input of [undefined, null, 42, {}, ["a=1"]]) {
        const result = parseQuery(/** @type {any} */ (input));
        assert.equal(Object.keys(result).length, 0);
        assert.equal(Object.getPrototypeOf(result), null);
    }
});

test("the result carries no prototype, so header-shaped keys are plain data", () => {
    const result = parseQuery("constructor=x&__proto__=y&hasOwnProperty=z");
    assert.equal(Object.getPrototypeOf(result), null);
    assert.equal(result.constructor, "x");
    assert.equal(result.hasOwnProperty, "z");
});
