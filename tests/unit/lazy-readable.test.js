// The request says Readable and does not build one until something asks.
//
// Worth about a tenth of a hello-world, and worth nothing at all if a door is left unguarded: what
// would come out is not a slow path but a TypeError on `undefined._readableState`, in whatever
// corner of a stream nobody tested. So this checks the shape of the thing rather than one route
// through it: every own member of Readable's prototype must be answered without the state, and
// touching any of them must leave a real stream behind.

const test = require("node:test");
const assert = require("node:assert");
const { Readable } = require("node:stream");

const Request = require("../../src/request.js");

// enough of a µWS request and response for the constructor, which reads a handful of headers
function fakeUws() {
    const req = {
        getUrl: () => "/",
        getMethod: () => "get",
        getQuery: () => undefined,
        getHeader: () => "",
        getParameter: () => "",
        forEach: () => {},
        setYield: () => {},
        getCaseSensitiveMethod: () => "GET"
    };
    const res = {
        onAborted: () => {},
        getRemoteAddressAsText: () => Buffer.from("127.0.0.1"),
        getRemoteAddress: () => Buffer.alloc(4),
        getProxiedRemoteAddress: () => Buffer.alloc(0)
    };
    const app = {
        get: () => undefined,
        set: () => {},
        enabled: () => false,
        settings: {},
        _router: null
    };
    return [req, res, app];
}

function newRequest() {
    const [req, res, app] = fakeUws();
    return new Request(req, res, app);
}

test("a fresh request is a Readable and has none of one", () => {
    const request = newRequest();
    assert.ok(request instanceof Readable, "code that checks the type must still see a Readable");
    assert.strictEqual(typeof request.pipe, "function");
    assert.strictEqual(request._readableState, undefined, "the whole point: no state until asked");
    // and it reads as readable, which the plain flag answers
    assert.strictEqual(request.readable, true);
});

test("every door into Readable builds the state rather than tripping over its absence", () => {
    const doors = [
        ["on", (r) => r.on("data", () => {})],
        ["once", (r) => r.once("end", () => {})],
        ["addListener", (r) => r.addListener("readable", () => {})],
        ["removeListener", (r) => r.removeListener("data", () => {})],
        ["read", (r) => r.read()],
        ["pause", (r) => r.pause()],
        ["resume", (r) => r.resume()],
        ["isPaused", (r) => r.isPaused()],
        ["setEncoding", (r) => r.setEncoding("utf8")],
        ["push", (r) => r.push(null)],
        ["destroy", (r) => r.destroy()],
        ["readableLength", (r) => r.readableLength],
        ["readableEnded", (r) => r.readableEnded],
        ["readableHighWaterMark", (r) => r.readableHighWaterMark],
        ["readableFlowing", (r) => r.readableFlowing],
        ["destroyed", (r) => r.destroyed],
        ["asyncIterator", (r) => r[Symbol.asyncIterator]()]
    ];

    for (const [name, open] of doors) {
        const request = newRequest();
        open(request);
        assert.notStrictEqual(request._readableState, undefined, `${name} left no stream behind`);
        assert.strictEqual(request.readableHighWaterMark, 128 * 1024, `${name} built the wrong stream`);
    }
});

test("what EventEmitter owns needs no stream, and behaves as it always did", () => {
    const request = newRequest();
    // prependListener is EventEmitter's, not Readable's, and never reads the state: it behaves the
    // same whether or not one has been built, which is why it is not wrapped
    request.prependListener("data", () => {});
    assert.strictEqual(request._readableState, undefined);
    assert.strictEqual(request.listenerCount("data"), 1);

    // once goes through on(), so it does build one
    request.once("end", () => {});
    assert.notStrictEqual(request._readableState, undefined);
});

test("no member of Readable's prototype is left unwrapped", () => {
    const guarded = Object.getPrototypeOf(Object.getPrototypeOf(Request.prototype));
    const wrapped = new Set([
        ...Object.getOwnPropertyNames(guarded),
        ...Object.getOwnPropertySymbols(guarded).map((s) => s.toString())
    ]);

    for (const member of Object.getOwnPropertyNames(Readable.prototype)) {
        if (member === "constructor") continue;
        assert.ok(wrapped.has(member), `${member} would reach an undefined state`);
    }
    for (const member of Object.getOwnPropertySymbols(Readable.prototype)) {
        assert.ok(wrapped.has(member.toString()), `${member.toString()} would reach an undefined state`);
    }
});

test("listeners survive the stream being built under them", () => {
    const request = newRequest();
    const seen = [];

    // any on() builds the stream, including for an event Readable knows nothing about. Telling
    // them apart would mean reading which events node's own on() actually uses the state for, and
    // nothing on the hot path registers a listener on a request at all, so the whole distinction
    // would buy nothing and could only be got wrong
    request.on("aborted", () => seen.push("aborted"));
    assert.notStrictEqual(request._readableState, undefined);

    request.on("data", () => seen.push("data"));

    request.emit("aborted");
    assert.deepStrictEqual(seen, ["aborted"], "the listener from before must still be there");
    assert.strictEqual(request.listenerCount("data"), 1);
    assert.strictEqual(request.listenerCount("aborted"), 1);
});

test("a body still arrives through the stream", async () => {
    const request = newRequest();
    const chunks = [];
    const done = new Promise((resolve) => {
        request.on("data", (chunk) => chunks.push(chunk.toString()));
        request.on("end", resolve);
    });

    request.push(Buffer.from("hello "));
    request.push(Buffer.from("world"));
    request.push(null);

    await done;
    assert.strictEqual(chunks.join(""), "hello world");
    assert.strictEqual(request.readableEnded, true);
});
