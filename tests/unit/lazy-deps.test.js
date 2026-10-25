// mime-db, qs, fast-zlib and acorn are loaded on first use, and acorn is released after listen():
// about a megabyte of old generation, which decides whether V8 runs its full collections.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const index = JSON.stringify(path.join(__dirname, "..", "..", "src", "index.js"));
const heavy = ["mime-types", "mime-db", "qs", "fast-zlib", "type-is", "accepts", "compressible", "acorn"];

/**
 * @param {string} script
 * @returns {string[]} the heavy packages in require.cache when the script prints
 */
function loadedAfter(script) {
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    assert.strictEqual(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

const listLoaded = `
    const heavy = ${JSON.stringify(heavy)};
    const loaded = () => heavy.filter((name) =>
        Object.keys(require.cache).some((file) => file.includes("/node_modules/" + name + "/") || file.includes("\\\\node_modules\\\\" + name + "\\\\")));
`;

test("a listening app with a plain route holds none of the heavy dependencies", () => {
    const loaded = loadedAfter(`
        ${listLoaded}
        const express = require(${index});
        const app = express();
        app.get("/a", (req, res) => res.send("a"));
        app.post("/echo", express.raw({ type: () => true }), (req, res) => res.send(req.body));
        const server = app.listen(0, () => {
            process.stdout.write(JSON.stringify(loaded()));
            server.close();
        });
    `);
    assert.deepStrictEqual(loaded, []);
});

test("a route added after listen() still answers", async () => {
    const result = spawnSync(
        process.execPath,
        [
            "-e",
            `
            const express = require(${index});
            const app = express();
            app.get("/a", (req, res) => res.send("a"));
            const server = app.listen(0, async () => {
                app.get("/b", (req, res) => res.send("b"));
                const body = await fetch("http://127.0.0.1:" + server.address().port + "/b").then((r) => r.text());
                process.stdout.write(body);
                server.close();
            });
        `
        ],
        { encoding: "utf8" }
    );
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, "b");
});

test("the dependencies still load where they are needed", () => {
    const loaded = loadedAfter(`
        ${listLoaded}
        const express = require(${index});
        const app = express();
        app.set("query parser", "extended");
        app.get("/a", (req, res) => res.type("json").send(req.query));
        const server = app.listen(0, async () => {
            await fetch("http://127.0.0.1:" + server.address().port + "/a?x[y]=1").then((r) => r.text());
            process.stdout.write(JSON.stringify(loaded()));
            server.close();
        });
    `);
    assert.ok(loaded.includes("qs"), loaded.join());
    assert.ok(loaded.includes("mime-types"), loaded.join());
});
