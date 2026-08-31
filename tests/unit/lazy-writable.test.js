// The response says Writable and does not build one until something asks.
//
// The mirror of lazy-readable.test.js, and it checks the same shape rather than one route through
// it: every own member of Writable's prototype must be answered without the state, and touching any
// of them must leave a real stream behind. A door left unguarded would not be a slow path but a
// TypeError on `undefined._writableState`.
//
// One thing is deliberately not deferred: the EventEmitter half. The constructor arms its abort and
// close listeners by writing straight into _events, so that map has to exist, with the five keys
// node's own Writable constructor lays down and in that order.

const test = require("node:test");
const assert = require("node:assert");
const { Writable, Readable } = require("node:stream");

const express = require("../../src/index.js");

/**
 * A response built the way a request would build one, without a server.
 * @returns {any}
 */
function newResponse() {
    const app = express();
    const uwsRes = {
        onAborted: () => {},
        cork: (/** @type {Function} */ fn) => fn(),
        writeStatus: () => {},
        writeHeader: () => {},
        write: () => true,
        end: () => {},
        getWriteOffset: () => 0,
        onWritable: () => {},
        close: () => {}
    };
    const req = { _connectionClose: false, headers: {}, method: "GET" };
    return new app._response(uwsRes, req, app);
}

test("a fresh response is a Writable and has none of one", () => {
    const res = newResponse();
    assert.ok(res instanceof Writable, "code that checks the type must still see a Writable");
    assert.strictEqual(typeof res.write, "function");
    assert.strictEqual(res._writableState, undefined, "the whole point: no state until asked");
});

test("the event map is the one node's own constructor would have written", () => {
    const res = newResponse();
    const shape = Object.keys(res._events);
    // the two the constructor arms are filled in, the rest are the placeholders node leaves
    assert.deepStrictEqual(shape, ["close", "error", "prefinish", "finish", "drain"]);
    assert.strictEqual(typeof res._events.error, "function");
    assert.strictEqual(typeof res._events.close, "function");
    assert.strictEqual(res._eventsCount, 2);

    // and it is the same shape a real Writable arrives with, which is what makes the direct write
    // above produce the hidden class every other stream in the process has
    assert.deepStrictEqual(Object.keys(new Writable()._events), shape);
});

test("every door into Writable builds the state rather than tripping over its absence", () => {
    // writableEnded and writableFinished are not doors: both are answered from the response's
    // own finished flag, which is the same answer without a stream behind it
    const doors = [
        ["write", (/** @type {any} */ r) => r.write("x")],
        ["cork", (/** @type {any} */ r) => r.cork()],
        ["uncork", (/** @type {any} */ r) => r.uncork()],
        ["setDefaultEncoding", (/** @type {any} */ r) => r.setDefaultEncoding("utf8")],
        ["destroy", (/** @type {any} */ r) => r.destroy()],
        ["writableLength", (/** @type {any} */ r) => r.writableLength],
        ["writableHighWaterMark", (/** @type {any} */ r) => r.writableHighWaterMark],
        ["writableObjectMode", (/** @type {any} */ r) => r.writableObjectMode],
        ["writableCorked", (/** @type {any} */ r) => r.writableCorked],
        ["writableNeedDrain", (/** @type {any} */ r) => r.writableNeedDrain],
        ["destroyed", (/** @type {any} */ r) => r.destroyed],
        ["errored", (/** @type {any} */ r) => r.errored],
        ["closed", (/** @type {any} */ r) => r.closed]
    ];

    for (const [name, open] of doors) {
        const res = newResponse();
        open(res);
        assert.notStrictEqual(res._writableState, undefined, `${name} left no stream behind`);
    }
});

test("no member of Writable's prototype is left unwrapped", () => {
    const responseClass = newResponse().constructor;
    // the app's own subclass, then Response, then the lazy base that carries the wrappers
    const guarded = Object.getPrototypeOf(Object.getPrototypeOf(responseClass.prototype));
    const wrapped = new Set([
        ...Object.getOwnPropertyNames(guarded),
        ...Object.getOwnPropertySymbols(guarded).map((s) => s.toString())
    ]);

    /** Whether reaching this member could run node's code, which is what needs the state first. */
    const needsGuarding = (/** @type {string|symbol} */ member) => {
        const d = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Writable.prototype, member));
        // `_writev` is a plain null on Writable's prototype: reading it runs nothing, so there is
        // nothing to materialise first and a wrapper would only be a lie about what it is
        return typeof d.value === "function" || d.get !== undefined || d.set !== undefined;
    };

    for (const member of Object.getOwnPropertyNames(Writable.prototype)) {
        if (member === "constructor" || !needsGuarding(member)) continue;
        assert.ok(wrapped.has(member), `${member} would reach an undefined state`);
    }
    for (const member of Object.getOwnPropertySymbols(Writable.prototype)) {
        if (!needsGuarding(member)) continue;
        assert.ok(wrapped.has(member.toString()), `${member.toString()} would reach an undefined state`);
    }
});

test("writableFinished still answers without a stream, since the response owns it", () => {
    const res = newResponse();
    assert.strictEqual(res.writableFinished, false);
    assert.strictEqual(res._writableState, undefined, "the response's own getter must not build one");
});

test("what is piped in still arrives, and the stream is built under it", async () => {
    const res = newResponse();
    const written = [];
    // the sink, so what pipe pushes through can be seen without a socket
    res._write = (/** @type {any} */ chunk, /** @type {any} */ enc, /** @type {any} */ cb) => {
        written.push(chunk.toString());
        cb(null);
    };

    await new Promise((resolve, reject) => {
        const source = Readable.from([Buffer.from("hello "), Buffer.from("world")]);
        source.on("error", reject);
        res.on("fulmine-drained", resolve);
        source.pipe(res);
        // end() is the response's own and never reaches Writable, so the finish this waits on is
        // raised by the sink above rather than by the stream machinery
        setTimeout(() => res.emit("fulmine-drained"), 50);
    });

    assert.notStrictEqual(res._writableState, undefined);
    assert.strictEqual(written.join(""), "hello world");
});
