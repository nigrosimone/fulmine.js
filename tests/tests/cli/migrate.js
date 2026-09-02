// must rewrite the import and only the import
// INSPECT

// The harness runs every test twice and compares the output, so it insists on this line even
// though what is being checked here is the CLI and not the server. A wrong answer throws rather
// than printing, since printing the same wrong answer twice would compare equal and pass.
const express = require("express");

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const cli = path.join(__dirname, "../../../src/cli.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-migrate-"));

const FIXTURES = {
    "cjs.js": [
        'const express = require("express");',
        'const session = require("express-session");',
        "const single = require('express');",
        'const notAnImport = "express";',
        '// require("express") in a comment',
        "module.exports = express;"
    ].join("\n"),
    "esm.mjs": [
        'import express from "express";',
        'import { Router } from "express";',
        'export * from "express";',
        'const lazy = await import("express");',
        "export default [express, Router, lazy];"
    ].join("\n"),
    // TypeScript has spellings of its own, and acorn cannot read any of them, so these go through
    // the compiler the project being migrated already has
    "typed.ts": [
        'import express from "express";',
        'import type { Request, Response } from "express";',
        'import session from "express-session";',
        'import legacy = require("express");',
        'const lazy = import("express");',
        'const notAnImport = "express";',
        "const app: express.Application = express();",
        "export default [app, session, legacy, lazy, notAnImport, {} as Request, {} as Response];"
    ].join("\n"),
    "component.tsx": [
        'import express from "express";',
        "const el = <div className='x'>hi</div>;",
        "export default [express, el];"
    ].join("\n"),
    "unparsable.js": 'const express = require("express"',
    "node_modules/dep/index.js": 'const express = require("express");',
    // modules with something built in here. They are reported, never rewritten, and a file that
    // uses one without naming express has to be read all the same
    "middlewares.js": [
        'const compression = require("compression");',
        'const bodyParser = require("body-parser");',
        'const notAnImport = "serve-static";',
        "module.exports = [compression, bodyParser, notAnImport];"
    ].join("\n")
};

for (const [name, content] of Object.entries(FIXTURES)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function assert(what, condition) {
    if (!condition) {
        throw new Error("failed: " + what);
    }
    console.log("ok:", what);
}

try {
    const dryRun = execFileSync(process.execPath, [cli, "migrate", "--dry-run", root]).toString();
    assert(
        "a dry run rewrites nothing",
        fs.readFileSync(path.join(root, "cjs.js"), "utf8").includes('require("express")')
    );
    assert("a dry run still counts what it found", dryRun.includes("would rewrite 11 import(s) in 4 file(s)"));

    const migrated = execFileSync(process.execPath, [cli, "migrate", root]).toString();
    const cjs = fs.readFileSync(path.join(root, "cjs.js"), "utf8");
    const esm = fs.readFileSync(path.join(root, "esm.mjs"), "utf8");
    const typed = fs.readFileSync(path.join(root, "typed.ts"), "utf8");
    const component = fs.readFileSync(path.join(root, "component.tsx"), "utf8");

    assert("require is rewritten", cjs.includes('require("fulmine.js")'));
    assert("the quote style is kept", cjs.includes("require('fulmine.js')"));
    assert("a different package is left alone", cjs.includes('require("express-session")'));
    assert("a string that is not an import is left alone", cjs.includes('const notAnImport = "express";'));
    assert("a comment is left alone", cjs.includes('// require("express") in a comment'));
    assert("import, export and dynamic import are all rewritten", !esm.includes('"express"'));
    assert("import from is rewritten", esm.includes('import express from "fulmine.js";'));
    assert(
        "a type-only import is rewritten too",
        typed.includes('import type { Request, Response } from "fulmine.js";')
    );
    assert("import equals require is rewritten", typed.includes('import legacy = require("fulmine.js");'));
    assert(
        "every TypeScript import is rewritten",
        !typed.includes('from "express"') && !typed.includes('require("express")')
    );
    assert(
        "a type annotation naming the local binding is left alone",
        typed.includes("const app: express.Application")
    );
    assert(
        "a string that is not an import is left alone in TypeScript too",
        typed.includes('const notAnImport = "express";')
    );
    assert(
        "tsx is rewritten and its JSX survives",
        component.includes('from "fulmine.js"') && component.includes("<div className='x'>")
    );
    assert(
        "a file that does not parse is left alone",
        fs.readFileSync(path.join(root, "unparsable.js"), "utf8").includes('require("express"')
    );
    assert(
        "node_modules is not walked",
        fs.readFileSync(path.join(root, "node_modules/dep/index.js"), "utf8").includes('require("express")')
    );

    assert(
        "a module with something built in here is named",
        migrated.includes("compression -> express.compression()") && migrated.includes("body-parser -> express.json()")
    );
    assert(
        "and a string that only looks like one is not",
        !migrated.includes("serve-static -> ") &&
            fs.readFileSync(path.join(root, "middlewares.js"), "utf8").includes('require("compression")')
    );

    const differences = execFileSync(process.execPath, [cli, "differences"]).toString();
    assert("differences names the one that bites first", differences.includes("app.listen() returns the app"));
    assert("a migration that changed something says what to check", migrated.includes("app.listen() returns the app"));

    // nothing left to find, so nothing to warn about either
    const again = execFileSync(process.execPath, [cli, "migrate", root]).toString();
    assert("running it twice rewrites nothing the second time", again.includes("rewrote 0 import(s)"));
    assert("and says nothing about differences", !again.includes("app.listen() returns the app"));
    // the modules are still installed, so that half is still worth saying
    assert("but still names the modules to replace", again.includes("compression -> express.compression()"));
    assert("express is still the thing being replaced", typeof express === "function");

    // typescript 7 is the compiler rewritten in Go: require("typescript") is a version number and
    // the parser used above is not published any more, so .ts files go through its scanner instead.
    // The project below lives under node_modules so that the stand-in package, which is only an
    // exports map onto the real typescript 7 installed here, resolves it by name
    const ts7Root = path.join(__dirname, "../../../node_modules/.fulmine-migrate-ts7");
    fs.rmSync(ts7Root, { recursive: true, force: true });
    try {
        const stub = path.join(ts7Root, "node_modules/typescript");
        fs.mkdirSync(stub, { recursive: true });
        fs.writeFileSync(
            path.join(stub, "package.json"),
            JSON.stringify({
                name: "typescript",
                version: "7.0.2",
                type: "module",
                exports: {
                    ".": "./version.cjs",
                    "./unstable/ast": "./ast.js",
                    "./unstable/ast/scanner": "./scanner.js"
                }
            })
        );
        fs.writeFileSync(
            path.join(stub, "version.cjs"),
            'module.exports = { version: "7.0.2", versionMajorMinor: "7.0" };'
        );
        fs.writeFileSync(path.join(stub, "ast.js"), 'export * from "typescript7/unstable/ast";');
        fs.writeFileSync(path.join(stub, "scanner.js"), 'export * from "typescript7/unstable/ast/scanner";');

        fs.writeFileSync(path.join(ts7Root, "typed.ts"), FIXTURES["typed.ts"]);
        fs.writeFileSync(path.join(ts7Root, "component.tsx"), FIXTURES["component.tsx"]);
        fs.writeFileSync(path.join(ts7Root, "middlewares.js"), FIXTURES["middlewares.js"]);

        const out = execFileSync(process.execPath, [cli, "migrate", ts7Root]).toString();
        const ts7Typed = fs.readFileSync(path.join(ts7Root, "typed.ts"), "utf8");
        const ts7Component = fs.readFileSync(path.join(ts7Root, "component.tsx"), "utf8");

        // the same two files, and the same five the tree found in them above
        assert(
            "typescript 7 rewrites as many imports as the tree did",
            out.includes("rewrote 5 import(s) in 2 file(s)")
        );
        assert(
            "every TypeScript import is rewritten under typescript 7 too",
            !ts7Typed.includes('from "express"') && !ts7Typed.includes('require("express")')
        );
        assert(
            "a type-only import is rewritten under typescript 7",
            ts7Typed.includes('import type { Request, Response } from "fulmine.js";')
        );
        assert(
            "import equals require is rewritten under typescript 7",
            ts7Typed.includes('import legacy = require("fulmine.js");')
        );
        assert(
            "a different package is left alone under typescript 7",
            ts7Typed.includes('import session from "express-session";')
        );
        assert(
            "a string that is not an import is left alone under typescript 7",
            ts7Typed.includes('const notAnImport = "express";')
        );
        assert(
            "a type annotation is left alone under typescript 7",
            ts7Typed.includes("const app: express.Application")
        );
        assert(
            "tsx is rewritten and its JSX survives under typescript 7",
            ts7Component.includes('from "fulmine.js"') && ts7Component.includes("<div className='x'>")
        );
        assert(
            "and the modules with something built in here are still named",
            out.includes("compression -> express.compression()")
        );
    } finally {
        fs.rmSync(ts7Root, { recursive: true, force: true });
    }

    // a typescript that is neither: no parser, and no scanner behind it either
    const noReader = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-migrate-noreader-"));
    try {
        const stub = path.join(noReader, "node_modules/typescript");
        fs.mkdirSync(stub, { recursive: true });
        fs.writeFileSync(path.join(stub, "package.json"), '{"name":"typescript","version":"8.0.0","main":"index.js"}');
        fs.writeFileSync(path.join(stub, "index.js"), 'module.exports = { version: "8.0.0" };');
        fs.writeFileSync(path.join(noReader, "typed.ts"), 'import express from "express";\n');

        const out = execFileSync(process.execPath, [cli, "migrate", "--dry-run", noReader]).toString();
        assert(
            "a typescript with nothing to read a file with does not crash",
            out.includes("1 TypeScript file(s) were left alone")
        );
    } finally {
        fs.rmSync(noReader, { recursive: true, force: true });
    }
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
