// A chunked request body goes through uWS's native collection now, the same door a declared
// content-length always took: one callback for the whole body, the limit enforced before any
// byte reaches JS. What these pin is the behaviour a streaming client sees: the parse, the 413,
// the empty body, and the request that carries no body declaration at all, which must answer
// rather than wait forever on a collection that has nothing to collect.

const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");

const express = require("../../src/index.js");

function serve(setup) {
    return new Promise((resolve) => {
        const app = express();
        setup(app);
        app.listen(0, () => {
            resolve({ port: app.address().port, close: () => app.close() });
        });
    });
}

/** One raw request, chunked when chunks are given, bare when null, answered as {status, body}. */
function rawPost(port, chunks, extraHeaders = "") {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
            let head = `POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nConnection: close\r\n${extraHeaders}`;
            if (chunks !== null) {
                head += "Transfer-Encoding: chunked\r\n\r\n";
                for (const chunk of chunks) {
                    head += chunk.length.toString(16) + "\r\n" + chunk + "\r\n";
                }
                head += "0\r\n\r\n";
            } else {
                head += "\r\n";
            }
            socket.write(head);
        });
        let data = "";
        socket.on("data", (chunk) => (data += chunk));
        socket.on("close", () => {
            const status = Number((data.match(/^HTTP\/1\.1 (\d+)/) || [])[1]);
            resolve({ status, body: data.split("\r\n\r\n").slice(1).join("\r\n\r\n") });
        });
        socket.on("error", reject);
        setTimeout(() => reject(new Error("no answer within 3s")), 3000).unref();
    });
}

test("a chunked JSON body is collected and parsed", async () => {
    const { port, close } = await serve((app) => {
        app.use(express.json());
        app.post("/echo", (req, res) => res.json(req.body));
    });
    try {
        const sent = JSON.stringify({ hello: "world", pad: "x".repeat(2000) });
        const answer = await rawPost(port, [sent.slice(0, 512), sent.slice(512)]);
        assert.strictEqual(answer.status, 200);
        assert.ok(answer.body.includes('"hello"'), answer.body);
        assert.ok(answer.body.includes("x".repeat(100)), "the second chunk's bytes must be there");
    } finally {
        close();
    }
});

test("a chunked body over the limit answers 413", async () => {
    const { port, close } = await serve((app) => {
        app.use(express.json({ limit: 1024 }));
        app.post("/echo", (req, res) => res.json(req.body));
        // the parser reports through the error path, as express does
        app.use((err, req, res, next) => res.status(err.status || 500).send(err.type || "error"));
    });
    try {
        const answer = await rawPost(port, ["x".repeat(1000), "y".repeat(1000)]);
        assert.strictEqual(answer.status, 413);
    } finally {
        close();
    }
});

test("an empty chunked body is the parser's empty value", async () => {
    const { port, close } = await serve((app) => {
        app.use(express.json());
        app.post("/echo", (req, res) => res.json({ got: req.body }));
    });
    try {
        const answer = await rawPost(port, []);
        assert.strictEqual(answer.status, 200);
        assert.ok(answer.body.includes('"got":{}'), answer.body);
    } finally {
        close();
    }
});

test("a POST with no length and no chunking still answers, and req.body stays unset", async () => {
    const { port, close } = await serve((app) => {
        app.use(express.json());
        app.post("/echo", (req, res) => res.json({ got: req.body }));
    });
    try {
        // no body declaration at all: the parser skips the request entirely, express leaves
        // req.body undefined there, and the one thing this must never do is wait for a body
        const answer = await rawPost(port, null);
        assert.strictEqual(answer.status, 200);
        assert.ok(answer.body.includes("{}"), answer.body);
    } finally {
        close();
    }
});
