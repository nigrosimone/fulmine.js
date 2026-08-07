// The response arms its own abort and cleanup listeners by writing into the event map rather than
// calling on(), which is worth about 6% of a hello-world. That is only safe if what it writes is
// exactly what on() would have written, so this pins the observable half: the count, the order, the
// removal, and what a listener added afterwards sees.

const test = require("node:test");
const assert = require("node:assert");
const { Writable } = require("node:stream");

// what the constructor does, in the shape response.js does it
function arm(emitter, onError, onClose) {
    const events = emitter._events;
    if (
        emitter._eventsCount === 0 &&
        events !== undefined &&
        events.error === undefined &&
        events.close === undefined
    ) {
        events.error = onError;
        events.close = onClose;
        emitter._eventsCount = 2;
        return "direct";
    }
    emitter.on("error", onError);
    emitter.on("close", onClose);
    return "on";
}

test("a fresh stream has both slots free, which is what makes the direct write safe", () => {
    const stream = new Writable();
    assert.strictEqual(stream._eventsCount, 0);
    // node shapes _events for a stream up front, close and error among the keys and every value
    // undefined. That is why filling two of them keeps the hidden class on() would have produced
    assert.notStrictEqual(stream._events, undefined);
    assert.strictEqual(stream._events.error, undefined);
    assert.strictEqual(stream._events.close, undefined);
});

test("the direct write is indistinguishable from on()", () => {
    const onError = () => {};
    const onClose = () => {};

    const direct = new Writable();
    assert.strictEqual(arm(direct, onError, onClose), "direct");

    const viaOn = new Writable();
    viaOn.on("error", onError);
    viaOn.on("close", onClose);

    for (const event of ["error", "close"]) {
        assert.strictEqual(direct.listenerCount(event), viaOn.listenerCount(event));
        assert.deepStrictEqual(direct.listeners(event), viaOn.listeners(event));
    }
    assert.strictEqual(direct._eventsCount, viaOn._eventsCount);
});

test("a listener added afterwards runs after the armed one, and removal leaves the other alone", () => {
    const seen = [];
    const stream = new Writable();
    arm(
        stream,
        () => seen.push("armed error"),
        () => seen.push("armed close")
    );

    // the application's own, which must come second: on() appends, and the armed one was there first
    stream.on("close", () => seen.push("user close"));
    stream.emit("close");
    assert.deepStrictEqual(seen, ["armed close", "user close"]);

    assert.strictEqual(stream.listenerCount("close"), 2);
    stream.removeAllListeners("close");
    assert.strictEqual(stream.listenerCount("close"), 0);
    // removing one event must not disturb the other
    assert.strictEqual(stream.listenerCount("error"), 1);

    stream.emit("error", new Error("boom"));
    assert.deepStrictEqual(seen, ["armed close", "user close", "armed error"]);
});

test("an emitter that already has one of the two falls back to on()", () => {
    const stream = new Writable();
    stream.on("error", () => {});
    assert.strictEqual(
        arm(
            stream,
            () => {},
            () => {}
        ),
        "on"
    );
    // the fallback must not lose the one that was already there
    assert.strictEqual(stream.listenerCount("error"), 2);
    assert.strictEqual(stream.listenerCount("close"), 1);
    assert.strictEqual(stream._eventsCount, 2);
});
