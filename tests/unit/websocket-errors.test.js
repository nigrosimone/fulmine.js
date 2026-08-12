// What app.ws() does when the upgrade hook fails, which is the half of it nothing else covers.
//
// A refusal is already tested: this is about a hook that throws, and about one whose promise
// rejects. Both have to close the handshake rather than leave the client holding it, and both have
// to reach the application's own 'error' listener rather than the process's.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const express = require("../../src/index.js");

/**
 * Opens a websocket handshake by hand and reports what came back, since a client library would
 * hide the status behind an error with no number in it.
 *
 * @param {number} port
 * @param {string} path
 * @returns {Promise<number>} the status the server answered the upgrade with
 */
function handshake(port, path) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            port,
            path,
            headers: {
                connection: "Upgrade",
                upgrade: "websocket",
                "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
                "sec-websocket-version": "13"
            }
        });
        req.on("response", (res) => {
            res.resume();
            resolve(/** @type {number} */ (res.statusCode));
        });
        req.on("upgrade", () => resolve(101));
        req.on("error", reject);
        req.end();
    });
}

test("an upgrade hook that throws refuses the socket and reports the error", async () => {
    const app = express();
    /** @type {any[]} */
    const seen = [];
    app.on("error", (err) => seen.push(err));
    app.ws("/boom", {
        upgrade() {
            throw new Error("no room");
        },
        message() {}
    });
    const server = app.listen(0);
    try {
        assert.strictEqual(await handshake(app.address().port, "/boom"), 500);
        assert.strictEqual(seen.length, 1, "the application heard about it");
        assert.strictEqual(seen[0].message, "no room");
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
});

test("an upgrade hook whose promise rejects does the same", async () => {
    const app = express();
    /** @type {any[]} */
    const seen = [];
    app.on("error", (err) => seen.push(err));
    app.ws("/later", {
        async upgrade() {
            await new Promise((resolve) => setTimeout(resolve, 5));
            throw new Error("checked, and no");
        },
        message() {}
    });
    const server = app.listen(0);
    try {
        assert.strictEqual(await handshake(app.address().port, "/later"), 500);
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].message, "checked, and no");
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
});

test("an upgrade that answers the response itself is left as it answered", async () => {
    const app = express();
    app.ws("/gated", {
        upgrade(req, res) {
            res.sendStatus(401);
        },
        message() {}
    });
    const server = app.listen(0);
    try {
        assert.strictEqual(await handshake(app.address().port, "/gated"), 401);
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
});

test("a websocket path µWS cannot match is refused where it is written", () => {
    const app = express();
    assert.throws(() => app.ws("/room/:id(\\d+)", { message() {} }), /is not one µWS can match/);
    // and the same on a router, where it is refused as it is written rather than at listen
    const router = express.Router();
    assert.throws(() => router.ws("/deep/*rest/tail", { message() {} }), /is not one µWS can match/);
});

test("a mounted websocket keeps the mount path, and a bare mount keeps the route's", async () => {
    const app = express();
    const router = express.Router();
    router.ws("/socket", { message() {} });
    router.ws("/", { message() {} });
    app.use("/rooms", router);
    const server = app.listen(0);
    try {
        const port = app.address().port;
        assert.strictEqual(await handshake(port, "/rooms/socket"), 101);
        assert.strictEqual(await handshake(port, "/rooms"), 101, "the router's own root");
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
});
