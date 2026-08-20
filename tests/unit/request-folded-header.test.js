// req._foldedHeader, which reads one header without building the whole headers object.
//
// It exists so a middleware that wants a single name, express.compression() reading
// Accept-Encoding on every request, does not materialize an object of a dozen entries for it. That
// only holds if it folds repeats exactly as the object does, so every case here asserts the two
// against each other rather than against a value written by hand: whatever req.headers says is the
// answer, and this has to say the same. Raw sockets because no http client will send a header
// twice.

const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");

const express = require("../../src/index.js");

/**
 * Serves one route that reports, for each name asked about, what the two doors answer. The folded
 * read happens first, while nothing has built the object yet, which is the state it is written for.
 *
 * @param {string[]} names
 * @returns {Promise<{port: number, close: () => void}>}
 */
function serve(names) {
    return new Promise((resolve) => {
        const app = express();
        app.get("/", (req, res) => {
            const folded = {};
            for (const name of names) {
                folded[name] = req._foldedHeader(name) ?? null;
            }
            // only now, so the reads above went through the raw entries
            const object = {};
            for (const name of names) {
                const value = req.headers[name];
                object[name] = value === undefined ? null : value;
            }
            res.json({ folded, object });
        });
        app.listen(0, () => resolve({ port: app.address().port, close: () => app.close() }));
    });
}

/**
 * @param {number} port
 * @param {string} headerBlock the lines between the request line and the empty one
 * @returns {Promise<any>}
 */
function ask(port, headerBlock) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
            socket.write(`GET / HTTP/1.1\r\nHost: x\r\n${headerBlock}\r\n`);
        });
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk;
            const at = buffer.indexOf("\r\n\r\n");
            if (at !== -1) {
                const body = buffer.slice(at + 4);
                if (body.includes("}")) {
                    socket.destroy();
                    resolve(JSON.parse(body.slice(body.indexOf("{"))));
                }
            }
        });
        socket.on("error", reject);
    });
}

test("a header sent once reads the same either way", async () => {
    const server = await serve(["accept-encoding"]);
    try {
        const seen = await ask(server.port, "Accept-Encoding: gzip\r\n");
        assert.strictEqual(seen.folded["accept-encoding"], "gzip");
        assert.deepStrictEqual(seen.folded, seen.object);
    } finally {
        server.close();
    }
});

test("a repeated header joins with a comma, as the object does", async () => {
    const server = await serve(["accept-encoding"]);
    try {
        const seen = await ask(server.port, "Accept-Encoding: gzip\r\nAccept-Encoding: br\r\n");
        assert.strictEqual(seen.folded["accept-encoding"], "gzip, br");
        assert.deepStrictEqual(seen.folded, seen.object);
    } finally {
        server.close();
    }
});

test("a repeated cookie joins with a semicolon, which is what a cookie header means", async () => {
    const server = await serve(["cookie"]);
    try {
        const seen = await ask(server.port, "Cookie: a=1\r\nCookie: b=2\r\n");
        assert.strictEqual(seen.folded.cookie, "a=1; b=2");
        assert.deepStrictEqual(seen.folded, seen.object);
    } finally {
        server.close();
    }
});

test("a name that keeps only its first value keeps only its first", async () => {
    // content-type is one of those: node drops the repeat rather than joining it
    const server = await serve(["content-type"]);
    try {
        const seen = await ask(server.port, "Content-Type: text/plain\r\nContent-Type: text/html\r\n");
        assert.strictEqual(seen.folded["content-type"], "text/plain");
        assert.deepStrictEqual(seen.folded, seen.object);
    } finally {
        server.close();
    }
});

test("a header nobody sent reads as absent either way", async () => {
    const server = await serve(["accept-encoding", "x-nothing"]);
    try {
        const seen = await ask(server.port, "Accept-Encoding: gzip\r\n");
        assert.strictEqual(seen.folded["x-nothing"], null);
        assert.deepStrictEqual(seen.folded, seen.object);
    } finally {
        server.close();
    }
});

test("once the object exists the folded read answers from it", async () => {
    const app = express();
    let sameAfterwards = null;
    app.get("/", (req, res) => {
        // build the object first, which is the other half of the branch
        const fromObject = req.headers["accept-encoding"];
        sameAfterwards = req._foldedHeader("accept-encoding") === fromObject;
        res.end("ok");
    });
    await new Promise((resolve) => app.listen(0, resolve));
    try {
        await fetch(`http://127.0.0.1:${app.address().port}/`, { headers: { "accept-encoding": "gzip" } });
        assert.strictEqual(sameAfterwards, true);
    } finally {
        app.close();
    }
});
