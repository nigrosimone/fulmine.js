// The local eslint rule that flags an allocation a branch leaves before reading, see
// eslint-rules/no-early-allocation.mjs. One case per thing it counts and per thing it does not.

const test = require("node:test");
const assert = require("node:assert");
const { Linter } = require("eslint");

const linter = new Linter();

async function lint(code) {
    const rule = (await import("../../eslint-rules/no-early-allocation.mjs")).default;
    return linter
        .verify(code, {
            languageOptions: { ecmaVersion: "latest", sourceType: "commonjs" },
            plugins: { local: { rules: { r: rule } } },
            rules: { "local/r": "error" }
        })
        .map((m) => m.message);
}

test("an allocation declared before a return that never reads it is reported", async () => {
    for (const init of ["() => 1", "[]", "{}", "new Map()", "class {}"]) {
        const out = await lint(`function f(x) { const a = ${init}; if (x) return; use(a); }`);
        assert.strictEqual(out.length, 1, init);
        assert.match(out[0], /'a' is built here, and line 1 can leave before line 1 reads it/);
    }
});

test("continue and break count as leaving, but not out of a loop or switch inside the statement", async () => {
    assert.strictEqual((await lint("for (const x of xs) { const a = []; if (x) continue; use(a); }")).length, 1);
    assert.strictEqual((await lint("for (const x of xs) { const a = []; for (;;) { break; } use(a); }")).length, 0);
    assert.strictEqual(
        (await lint("for (const x of xs) { const a = []; switch (x) { case 1: break; } use(a); }")).length,
        0
    );
});

test("a throw, a call, a cheap initializer and a return inside a nested function are not reported", async () => {
    assert.strictEqual((await lint("function f(x) { const a = []; if (x) throw new Error(); use(a); }")).length, 0);
    assert.strictEqual((await lint("function f(x) { const a = g(); if (x) return; use(a); }")).length, 0);
    assert.strictEqual((await lint("function f(x) { const a = x.y; if (x) return; use(a); }")).length, 0);
    assert.strictEqual(
        (await lint("function f(x) { const a = []; const g = () => { return; }; use(a, g); }")).length,
        0
    );
});

test("read before the exit, or read by the exiting statement itself, is fine", async () => {
    assert.strictEqual((await lint("function f(x) { const a = []; use(a); if (x) return; use(a); }")).length, 0);
    assert.strictEqual((await lint("function f(x) { const a = []; if (x) return a; use(a); }")).length, 0);
});
