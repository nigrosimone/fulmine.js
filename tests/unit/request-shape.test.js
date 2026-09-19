// A request keeps V8's fast properties after an error handler passes it on. next() from an error
// handler used to delete the two error fields, and a delete puts the object in dictionary mode,
// where every field read for the rest of the request is a hash lookup.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("the request stays in fast-properties mode after next() from an error handler", () => {
    const script = `
        const express = require(${JSON.stringify(path.join(__dirname, "..", "..", "src", "index.js"))});
        const app = express();
        let seen = null;
        app.get("/e", (req, res, next) => next(new Error("boom")));
        app.use((err, req, res, next) => next());
        app.use((req, res) => { seen = req; res.status(404).send("after"); });
        const server = app.listen(0, async () => {
            const port = server.address().port;
            for (let i = 0; i < 3; i++) await fetch("http://127.0.0.1:" + port + "/e").then((r) => r.text());
            process.stdout.write(String(%HasFastProperties(seen)));
            app.close(() => process.exit(0));
        });
    `;
    // the exit delay: node crashes at exit on Windows with undici's sockets still open
    const preload = path.join(__dirname, "..", "win-exit-delay.cjs");
    const result = spawnSync(process.execPath, ["--allow-natives-syntax", "--require", preload, "-e", script], {
        encoding: "utf8"
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, "true");
});
