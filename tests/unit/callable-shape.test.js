// The callable app and router keep V8's fast properties. _asCallable copies the instance's own
// properties onto a function, and past about a dozen keyed stores V8 turns a function into
// dictionary mode, where every field read on the request path is a hash lookup.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("the callable app and router are in fast-properties mode", () => {
    const script = `
        const express = require(${JSON.stringify(path.join(__dirname, "..", "..", "src", "index.js"))});
        const app = express();
        const router = express.Router();
        router.get("/r/:id", (req, res) => res.send(req.params.id));
        app.use("/m", router);
        app.get("/a", (req, res) => res.send("a"));
        app.set("etag", false);
        process.stdout.write([%HasFastProperties(app), %HasFastProperties(router)].join(" "));
    `;
    const result = spawnSync(process.execPath, ["--allow-natives-syntax", "-e", script], { encoding: "utf8" });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, "true true");
});
