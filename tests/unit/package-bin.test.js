// The name the CLI is published under. npm writes the shim in node_modules/.bin under the bin's
// own name, so a bin called "fulmine.js" is a file with a .js extension: on Windows the shell
// opens it with whatever handles that extension instead of running it. From a project that had
// the package installed, `npx fulmine.js explain /api/items` printed nothing and exited 1, and in
// an editor it opened the shim itself. One bin, no extension, and npx still answers to
// `npx fulmine.js` because npm reads the name out of the manifest when the shim is not there.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const pkg = require("../../package.json");

test("the CLI is published under one bin, and windows can run it", () => {
    assert.deepEqual(Object.keys(pkg.bin), ["fulmine"]);

    for (const name of Object.keys(pkg.bin)) {
        assert.equal(
            path.extname(name),
            "",
            `the bin "${name}" has an extension, so windows opens it rather than running it`
        );
    }

    assert.equal(pkg.bin.fulmine, "src/cli.js");
    assert.ok(
        fs.existsSync(path.join(__dirname, "../..", pkg.bin.fulmine)),
        "the bin points at a file that is not there"
    );
});
