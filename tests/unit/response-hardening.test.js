// sendFile's refusals and setHeader's throws, the response paths the comparison suite reaches
// only incidentally: a path that does not decode, a null byte, an escape from the root, each
// dotfiles policy, and the two ways setHeader refuses outright.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const express = require("../../src/index.js");

/**
 * Starts an app and answers a fetch helper bound to it.
 *
 * @param {(app: any) => void} setup
 * @returns {Promise<{url: string, close: () => void}>}
 */
function serve(setup) {
    return new Promise((resolve) => {
        const app = express();
        setup(app);
        app.listen(0, () => {
            resolve({ url: `http://localhost:${app.address().port}`, close: () => app.close() });
        });
    });
}

test("sendFile refuses what it must: bad encoding, null bytes, escapes from the root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-sendfile-"));
    fs.writeFileSync(path.join(root, "real.txt"), "the real file");

    const { url, close } = await serve((app) => {
        app.get("/file/:name", (req, res) => {
            res.sendFile(req.params.name, { root });
        });
        app.get("/raw", (req, res) => {
            // handed straight through, so the crafted strings reach sendFile unfiltered
            res.sendFile(String(req.query.p), { root });
        });
    });

    try {
        const ok = await fetch(`${url}/file/real.txt`);
        assert.equal(ok.status, 200);
        assert.equal(await ok.text(), "the real file");

        // a literal "%zz" is not decoded by sendFile: it names a file that does not exist,
        // and Express answers 404, verified against the real thing
        const badEncoding = await fetch(`${url}/raw?p=${encodeURIComponent("%zz")}`);
        assert.equal(badEncoding.status, 404);

        // a null byte never names a file
        const nullByte = await fetch(`${url}/raw?p=${encodeURIComponent("a\0b")}`);
        assert.equal(nullByte.status, 400);

        // climbing out of the root is forbidden, not found
        const escape = await fetch(`${url}/raw?p=${encodeURIComponent("../outside.txt")}`);
        assert.equal(escape.status, 403);
    } finally {
        close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("each dotfiles policy answers a dotfile its own way", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-dotfiles-"));
    fs.writeFileSync(path.join(root, ".secret"), "hidden");
    fs.writeFileSync(path.join(root, "plain.txt"), "visible");

    const { url, close } = await serve((app) => {
        app.use("/allow", express.static(root, { dotfiles: "allow" }));
        app.use("/deny", express.static(root, { dotfiles: "deny" }));
        app.use("/ignore", express.static(root, { dotfiles: "ignore" }));
        app.use((req, res) => res.status(404).send("fell through"));
    });

    try {
        const allowed = await fetch(`${url}/allow/.secret`);
        assert.equal(allowed.status, 200);
        assert.equal(await allowed.text(), "hidden");

        // for a dotfile that is the first segment under the mount, Express falls through on
        // both deny and ignore rather than answering 403: verified against the real thing,
        // and this test exists to keep the two agreeing
        const denied = await fetch(`${url}/deny/.secret`);
        assert.equal(denied.status, 404);
        assert.equal(await denied.text(), "fell through");

        const ignored = await fetch(`${url}/ignore/.secret`);
        assert.equal(ignored.status, 404);
        assert.equal(await ignored.text(), "fell through");

        // and a plain file is served under every policy
        for (const mount of ["allow", "deny", "ignore"]) {
            const plain = await fetch(`${url}/${mount}/plain.txt`);
            assert.equal(plain.status, 200);
        }
    } finally {
        close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("setHeader refuses a sent response and a name that is not a string", async () => {
    /** @type {any} */
    let sentError;
    /** @type {any} */
    let typeError;
    const { url, close } = await serve((app) => {
        app.get("/late", (req, res) => {
            res.send("gone");
            try {
                res.setHeader("X-Late", "too late");
            } catch (e) {
                sentError = e;
            }
        });
        app.get("/badname", (req, res) => {
            try {
                res.setHeader(42, "x");
            } catch (e) {
                typeError = e;
            }
            res.send("survived");
        });
    });

    await fetch(`${url}/late`);
    assert.match(String(sentError && sentError.message), /Cannot set headers after they are sent/);

    const res = await fetch(`${url}/badname`);
    assert.equal(await res.text(), "survived");
    assert.ok(typeError instanceof TypeError);
    assert.match(typeError.message, /Header name must be a valid HTTP token/);
    close();
});

test("getHeaders() answers a copy on a null prototype, so a write into it goes nowhere", async () => {
    /** @type {any} */
    let seen;
    const { url, close } = await serve((app) => {
        app.get("/x", (req, res) => {
            res.set("x-live", "a");
            const headers = res.getHeaders();
            seen = { value: headers["x-live"], proto: Object.getPrototypeOf(headers) };
            // node returns a copy, so this must not reach the wire, and it is also the hole a
            // CRLF would have used to skip setHeader's validation, see issue #6
            headers["x-injected"] = "yes";
            res.send("ok");
        });
    });

    try {
        const res = await fetch(`${url}/x`);
        assert.equal(res.status, 200);
        assert.strictEqual(res.headers.get("x-live"), "a");
        assert.strictEqual(seen.value, "a");
        assert.strictEqual(seen.proto, null);
        assert.strictEqual(res.headers.get("x-injected"), null);
    } finally {
        close();
    }
});
