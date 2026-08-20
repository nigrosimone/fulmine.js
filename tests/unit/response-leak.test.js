// Every response is linked into its app's pending list, which the graceful close() drains, and the
// unlink rides the 'close' listener the constructor arms. A terminal path that never emits 'close'
// therefore leaves the response linked for as long as the app lives, and with it the request, the
// headers and whatever body was read: a server that is never closed keeps them all. That is what
// the error path did.
//
// So each end a response can come to is walked here and the list has to be empty afterwards. Under
// --expose-gc, which is how `npm run test:unit` runs, the same question is asked without trusting
// the list to be the only thing that could hold them: the responses themselves have to be
// collectable. Only a WeakRef to each is kept, so nothing in the test is what keeps one alive.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("../../src/index.js");

const REQUESTS = 12;

/**
 * How many responses are still linked in the app's pending list.
 *
 * @param {any} app
 * @returns {number}
 */
function stillPending(app) {
    let count = 0;
    for (let response = app._pending.head; response !== null; response = response._pendingNext) {
        count++;
    }
    return count;
}

/**
 * One request, resolved on the end of the answer and equally on the connection dying under it,
 * since half of what is driven here is a response that kills its own socket.
 *
 * @param {number} port
 * @param {string} path
 * @returns {Promise<void>}
 */
function ask(port, path) {
    return new Promise((resolve) => {
        const request = http.request({ host: "127.0.0.1", port, path }, (response) => {
            response.resume();
            response.on("end", () => resolve());
            response.on("error", () => resolve());
        });
        request.on("error", () => resolve());
        // a handler that answers nothing would otherwise hang the suite rather than fail it
        request.setTimeout(2000, () => {
            request.destroy();
            resolve();
        });
        request.end();
    });
}

/**
 * Runs the route `count` times on a fresh app and hands back the app and a weak reference to every
 * response it saw. The last one answered can still be held by the frames that answered it, so a
 * few untracked requests follow to push it out.
 *
 * @param {(req: any, res: any) => void} handler what the route does
 * @param {number} count how many tracked requests to make
 * @returns {Promise<{app: any, refs: WeakRef<any>[], close: () => Promise<void>}>}
 */
async function drive(handler, count) {
    const app = express();
    app.set("etag", false);
    /** @type {WeakRef<any>[]} */
    const refs = [];
    app.get("/tracked", (req, res) => {
        refs.push(new WeakRef(res));
        handler(req, res);
    });
    app.get("/untracked", (req, res) => res.send("ok"));
    const server = app.listen(0);
    const port = app.address().port;
    for (let i = 0; i < count; i++) {
        await ask(port, "/tracked");
    }
    for (let i = 0; i < 3; i++) {
        await ask(port, "/untracked");
    }
    // an abort reaches the response after the handler has returned, so nothing is settled yet
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
        app,
        refs,
        close: () => new Promise((resolve) => server.close(() => resolve()))
    };
}

/**
 * How many of those responses are still reachable once V8 has been asked to collect. Several
 * passes, since one round can leave an object that only became unreachable during it.
 *
 * @param {WeakRef<any>[]} refs
 * @returns {Promise<number>}
 */
async function survivors(refs) {
    for (let i = 0; i < 4; i++) {
        globalThis.gc();
        await new Promise((resolve) => setImmediate(resolve));
    }
    return refs.filter((ref) => ref.deref() !== undefined).length;
}

/**
 * @param {import("node:test").TestContext} t
 * @param {WeakRef<any>[]} refs
 * @returns {Promise<void>}
 */
async function assertCollected(t, refs) {
    if (typeof globalThis.gc !== "function") {
        t.diagnostic("no --expose-gc, only the pending list was checked");
        return;
    }
    assert.strictEqual(await survivors(refs), 0, "responses were still reachable after a full gc");
}

test("a plain answer unlinks itself and is collected", async (t) => {
    const { app, refs, close } = await drive((req, res) => res.send("ok"), REQUESTS);
    try {
        assert.strictEqual(refs.length, REQUESTS);
        assert.strictEqual(stillPending(app), 0);
        await assertCollected(t, refs);
    } finally {
        await close();
    }
});

test("a response killed by an error event unlinks itself and is collected", async (t) => {
    // res.emit("error") rather than destroy(err): destroy emits 'close' too, and it was the error
    // arriving on its own that left the response linked
    const { app, refs, close } = await drive((req, res) => res.emit("error", new Error("boom")), REQUESTS);
    try {
        assert.strictEqual(refs.length, REQUESTS);
        assert.strictEqual(stillPending(app), 0);
        await assertCollected(t, refs);
    } finally {
        await close();
    }
});

test("a destroyed response unlinks itself and is collected", async (t) => {
    const { app, refs, close } = await drive((req, res) => res.destroy(new Error("gone")), REQUESTS);
    try {
        assert.strictEqual(stillPending(app), 0);
        await assertCollected(t, refs);
    } finally {
        await close();
    }
});
