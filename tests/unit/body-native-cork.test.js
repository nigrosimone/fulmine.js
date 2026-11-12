// A body collected natively is answered under the cork of uWS's data event: split, chunked, bigger
// than the cork buffer. uWS warns on stderr for a write outside a cork, so it runs in a child.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { otherRuntime } = require("../../src/uws.js");

const script = `
    const net = require("node:net");
    const express = require(${JSON.stringify(path.join(__dirname, "..", "..", "src", "index.js"))});
    const app = express();
    app.set("etag", false);
    app.post("/json", express.json(), (req, res) => res.json(req.body));
    app.post("/text", express.text({ type: () => true, limit: "1mb" }), (req, res) => res.send(req.body));
    // answered after the data event, this one needs its cork
    app.post("/late", express.text({ type: () => true }), (req, res) => setImmediate(() => res.send(req.body)));

    /** The head, then each piece in a packet of its own. */
    function ask(port, head, pieces) {
        return new Promise((resolve) => {
            const socket = net.connect(port, "127.0.0.1");
            let answer = "";
            socket.on("data", (chunk) => (answer += chunk));
            socket.on("close", () => resolve(answer.slice(answer.indexOf("\\r\\n\\r\\n") + 4)));
            socket.write(head);
            let sent = 0;
            const timer = setInterval(() => {
                if (sent < pieces.length) {
                    socket.write(pieces[sent++]);
                } else {
                    clearInterval(timer);
                    setTimeout(() => socket.end(), 100);
                }
            }, 25);
        });
    }

    app.listen(0, async () => {
        const port = app.address().port;
        const head = (url, length) =>
            "POST " + url + " HTTP/1.1\\r\\nHost: x\\r\\nContent-Type: application/json\\r\\n" +
            (length === null ? "Transfer-Encoding: chunked" : "Content-Length: " + length) + "\\r\\n\\r\\n";
        const json = JSON.stringify({ a: 1, b: "two" });
        const big = "y".repeat(300000);
        const out = {
            split: await ask(port, head("/json", json.length), [json.slice(0, 5), json.slice(5)]),
            big: (await ask(port, head("/text", big.length), [big.slice(0, 100000), big.slice(100000, 200000), big.slice(200000)])) === big,
            chunked: await ask(port, head("/text", null), ["5\\r\\nhello\\r\\n", "6\\r\\n world\\r\\n", "0\\r\\n\\r\\n"]),
            late: await ask(port, head("/late", 4), ["late"])
        };
        app.close();
        process.stdout.write(JSON.stringify(out));
        setTimeout(() => process.exit(0), 50);
    });
`;

// on Bun and Deno there is no uWS to cork
test("a native body is answered under uWS's cork", { skip: otherRuntime }, () => {
    const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 60000 });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /corked callback/);
    assert.deepStrictEqual(JSON.parse(run.stdout), {
        split: '{"a":1,"b":"two"}',
        big: true,
        chunked: "hello world",
        late: "late"
    });
});
