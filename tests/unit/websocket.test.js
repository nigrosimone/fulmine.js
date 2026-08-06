// app.ws(), which has no Express counterpart and so cannot be a comparison test: Express has no
// websockets of its own, and the shape here is µWS's behavior object plus this project's
// upgrade hook. What is pinned is the contract the readme promises: the request reaches every
// handler as ws.req and outlives the response, the upgrade hook can refuse, mounted routers
// compose their paths, and a path µWS cannot match is refused where it is written.

const test = require("node:test");
const assert = require("node:assert");

const express = require("../../src/index.js");

/**
 * Starts an app and answers its port plus a close helper.
 *
 * @param {(app: any) => void} setup
 * @returns {Promise<{app: any, port: number, close: () => Promise<void>}>}
 */
function serve(setup) {
    return new Promise((resolve) => {
        const app = express();
        setup(app);
        app.listen(0, () => {
            resolve({
                app,
                port: app.address().port,
                close: () => new Promise((done) => app.close(() => done()))
            });
        });
    });
}

/**
 * Opens a socket, collects what arrives, and answers once it closes or falls quiet.
 *
 * @param {number} port
 * @param {string} path
 * @param {string} [send] a message to send on open
 * @returns {Promise<{opened: boolean, messages: string[]}>}
 */
function talk(port, path, send) {
    return new Promise((resolve) => {
        const socket = new WebSocket(`ws://localhost:${port}${path}`);
        const messages = [];
        let opened = false;
        const done = () => resolve({ opened, messages });
        socket.onopen = () => {
            opened = true;
            if (send !== undefined) socket.send(send);
        };
        socket.onmessage = (event) => {
            messages.push(String(event.data));
            socket.close();
        };
        socket.onerror = done;
        socket.onclose = done;
        // a refused upgrade closes without a message, so the timer is only the last resort
        setTimeout(done, 2000);
    });
}

test("a socket echoes, and the path still serves HTTP", async () => {
    const { port, close } = await serve((app) => {
        app.ws("/echo", {
            message: (ws, message, isBinary) => ws.send(message, isBinary)
        });
        app.use((req, res) => res.status(404).send("no route"));
    });

    const talked = await talk(port, "/echo", "hello");
    assert.deepEqual(talked.messages, ["hello"]);

    // a plain GET on the same path is not an upgrade, so ordinary routing answers it
    const plain = await fetch(`http://localhost:${port}/echo`);
    assert.equal(plain.status, 404);
    assert.equal(await plain.text(), "no route");
    await close();
});

test("the request reaches the handlers and outlives the response", async () => {
    const { port, close } = await serve((app) => {
        app.ws("/room/:id", {
            upgrade(req) {
                // anything the hook learns rides along on the request itself
                req.checkedAt = "upgrade";
            },
            open(ws) {
                ws.send(
                    JSON.stringify({
                        id: ws.req.params.id,
                        token: ws.req.query.token,
                        checkedAt: ws.req.checkedAt,
                        header: ws.req.get("sec-websocket-version"),
                        path: ws.req.path,
                        // read after the upgrade: the response it came on is gone by now
                        ip: typeof ws.req.ip,
                        port: typeof ws.req.socket.remotePort
                    })
                );
            }
        });
    });

    const talked = await talk(port, "/room/42?token=abc");
    assert.deepEqual(JSON.parse(talked.messages[0]), {
        id: "42",
        token: "abc",
        checkedAt: "upgrade",
        header: "13",
        path: "/room/42",
        ip: "string",
        port: "number"
    });
    await close();
});

test("the upgrade hook refuses a socket by answering the request", async () => {
    const { port, close } = await serve((app) => {
        app.ws("/guarded", {
            upgrade(req, res) {
                if (req.query.token !== "good") {
                    return res.sendStatus(401);
                }
            },
            open: (ws) => ws.send("welcome")
        });
    });

    const allowed = await talk(port, "/guarded?token=good");
    assert.deepEqual(allowed.messages, ["welcome"]);

    const refused = await talk(port, "/guarded?token=bad");
    assert.equal(refused.opened, false);
    assert.deepEqual(refused.messages, []);
    await close();
});

test("an async upgrade holds the handshake and can still refuse", async () => {
    const { port, close } = await serve((app) => {
        app.ws("/slow", {
            async upgrade(req, res) {
                await new Promise((r) => setTimeout(r, 20));
                if (req.query.deny === "1") {
                    return res.sendStatus(403);
                }
                req.decided = "after the await";
            },
            open: (ws) => ws.send(ws.req.decided)
        });
    });

    const allowed = await talk(port, "/slow");
    assert.deepEqual(allowed.messages, ["after the await"]);

    const refused = await talk(port, "/slow?deny=1");
    assert.equal(refused.opened, false);
    await close();
});

test("a mounted router composes its mount path, and app.publish reaches the room", async () => {
    const { app, port, close } = await serve((app) => {
        const chat = express.Router();
        chat.ws("/lobby", {
            open(ws) {
                ws.subscribe("lobby");
                ws.send("joined " + ws.req.path);
            }
        });
        app.use("/chat", chat);
    });

    const joined = await talk(port, "/chat/lobby");
    assert.deepEqual(joined.messages, ["joined /chat/lobby"]);

    // and a broadcast from outside any socket reaches a subscriber
    const socket = new WebSocket(`ws://localhost:${port}/chat/lobby`);
    const broadcast = new Promise((resolve) => {
        socket.onmessage = (event) => {
            if (String(event.data) !== "joined /chat/lobby") resolve(String(event.data));
        };
    });
    await new Promise((resolve) => (socket.onopen = resolve));
    assert.equal(app.numSubscribers("lobby"), 1);
    setTimeout(() => app.publish("lobby", "everyone please"), 20);
    assert.equal(await broadcast, "everyone please");
    socket.close();
    await close();
});

test("what µWS could not match is refused where it is written, or at listen", async () => {
    const app = express();

    // shapes µWS does not match the way Express would
    for (const path of ["/files/*", "/flights/:from-:to", "/{optional}"]) {
        assert.throws(() => app.ws(path, { open() {} }), /is not one µWS can match/, path);
    }
    assert.throws(() => app.ws(42, { open() {} }), /requires a path string/);
    assert.throws(() => app.ws("/x"), /requires a behavior object/);
    assert.throws(() => app.ws("/x", { message: "not a function" }), /behavior\.message must be a function/);
    assert.throws(() => app.ws("/x", { upgrade: 1 }), /behavior\.upgrade must be a function/);

    // a mount µWS cannot match makes everything under it unreachable, and listen says so
    const router = express.Router();
    router.ws("/deep", { open() {} });
    app.use(/^\/regex/, router);
    assert.throws(() => app.listen(0), /sits under a mount µWS cannot match/);
});
