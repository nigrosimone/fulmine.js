// req.params names must be internalized: a name cut from a path is not, and each write under it
// looks up the string table (395ns against 32). A request cannot see it, so we ask V8.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { otherRuntime } = require("../../src/uws.js");

// on Bun and Deno there is no V8 to ask
test("req.params names are internalized", { skip: otherRuntime }, () => {
    const src = path.join(__dirname, "..", "..", "src");
    const script = `
        const express = require(${JSON.stringify(path.join(src, "index.js"))});
        const { patternToRegex, getPatternMeta, regexpGroupKeys } = require(${JSON.stringify(path.join(src, "utils.js"))});
        const out = {};
        // every name twice, the second copy was the slow case
        const app = express();
        const router = express.Router();
        for (let i = 0; i < 2; i++) {
            app.get("/native" + i + "/:nativeName/detail", (req, res) => res.send("ok"));
            router.get("/mounted" + i + "/:mountedName", (req, res) => res.send("ok"));
        }
        app.use("/api", router);
        for (let i = 0; i < 2; i++) {
            const meta = getPatternMeta(patternToRegex("/generic" + i + "/:genericName/*splatName"));
            out["paramNames " + i] = meta.paramNames.every((name) => %IsInternalizedString(name));
            out["outputNames " + i] = meta.outputNames.every((name) => %IsInternalizedString(name));
            const keys = regexpGroupKeys(new RegExp("^/own" + i + "/(?<ownName>[a-z]+)/(\\\\d+)$"));
            out["group keys " + i] = %IsInternalizedString(keys[0]) && keys[1] === 0;
        }
        app.listen(0, () => {
            const names = [];
            for (const route of [...app._routes, ...router._routes]) {
                if (route.optimizedParams) {
                    names.push(...route.optimizedParams);
                }
            }
            out.native = names.length;
            out["native names"] = names.every((name) => %IsInternalizedString(name));
            app.close();
            process.stdout.write(JSON.stringify(out));
        });
    `;
    const result = spawnSync(process.execPath, ["--allow-natives-syntax", "-e", script], {
        encoding: "utf8",
        timeout: 60000
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), {
        "paramNames 0": true,
        "outputNames 0": true,
        "group keys 0": true,
        "paramNames 1": true,
        "outputNames 1": true,
        "group keys 1": true,
        native: 4,
        "native names": true
    });
});
