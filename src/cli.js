#!/usr/bin/env node
/*
Copyright 2026 Nigro Simone

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// npx fulmine migrate [dir]
//
// Rewrites the module specifier and nothing else. An Express 5 app is a Fulmine app already, so
// there is no code to translate: what there is instead is a short list of things that behave
// differently, printed at the end, because no rewrite can find those for you.

const fs = require("fs");
const path = require("path");
const acorn = require("acorn");

const FROM = "express";
const TO = "fulmine.js";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".nyc_output", ".next"]);
const EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx"]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx"]);

// Printed after a migration, and by `npx fulmine differences` on its own. Each one is something
// a working Express 5 app can depend on and that Fulmine answers differently.
const DIFFERENCES = [
    [
        "app.listen() returns the app, not an http.Server",
        "There is no node http server underneath, so anything doing `const server = app.listen(...)` and then\n" +
            "reaching for server.close(), server.address() or attaching a websocket library to it needs a look.\n" +
            "app.close(), app.address() and app.listening exist and do what you would expect."
    ],
    [
        "an HTTPS server is configured through express(), not https.createServer()",
        "Pass uwsOptions to the constructor: express({ uwsOptions: { key_file_name, cert_file_name } }).\n" +
            "The same goes for plain HTTP: do not create a server yourself, call app.listen()."
    ],
    [
        "the request body is only read for POST, PUT, PATCH and QUERY",
        'A body sent with GET or DELETE is not read unless you add the method: app.set("body methods", [...]).'
    ],
    [
        "case sensitive routing matches Express: insensitive by default",
        "/Users and /users are the same route, as in Express 5. A request in the registered case is still\n" +
            'answered by the native router; set app.set("case sensitive routing", true) to make case matter.'
    ],
    [
        "x-powered-by is off by default",
        'Express sends X-Powered-By: Express unless told not to. Set app.set("x-powered-by", true) to send it.'
    ],
    [
        "a compiled route is framed differently and never answers 304",
        "A handler simple enough to be read at registration time is answered natively, which means chunked\n" +
            "framing with no Content-Length, and a conditional request gets the whole body rather than a 304.\n" +
            'app.set("declarative responses", false) turns that off.'
    ],
    [
        "headers are capped at 4096 bytes by default",
        "Node allows 16384. Set the UWS_HTTP_MAX_HEADERS_SIZE environment variable if you need more."
    ],
    [
        "a request body arriving slower than 16KB/s is dropped",
        "Node waits as long as the client needs. Uploads over very slow connections can fail here and\n" +
            "succeed on Express."
    ]
];

/**
 * Every .js, .mjs and .cjs file under dir, skipping the directories nobody wants rewritten.
 * @param {string} dir
 * @returns {string[]}
 */
function collectFiles(dir) {
    const found = [];
    /** @type {string[]} */
    const stack = [dir];
    while (stack.length) {
        const current = /** @type {string} */ (stack.pop());
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue; // unreadable directory, nothing to migrate in it
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
                    stack.push(full);
                }
            } else if (EXTENSIONS.has(path.extname(entry.name))) {
                found.push(full);
            }
        }
    }
    return found.sort();
}

/**
 * The TypeScript compiler belonging to the project being migrated, or null when it has none.
 *
 * acorn cannot read TypeScript, and shipping a parser that can would put megabytes into this
 * package for a command most people run once. A TypeScript project already has the compiler, so
 * it is resolved from there. A project without one is told its .ts files were left alone rather
 * than having them quietly skipped, which is what happened before they were looked at at all.
 *
 * @param {string} target directory being migrated
 * @returns {any|null}
 */
function loadTypeScript(target) {
    try {
        return require(require.resolve("typescript", { paths: [target, process.cwd()] }));
    } catch {
        return null;
    }
}

/**
 * The same specifiers, out of a TypeScript file. A separate walk because the compiler's tree is
 * not ESTree: the node kinds are different and children are visited through forEachChild.
 *
 * @param {string} source
 * @param {string} fileName decides whether JSX is allowed, so a .tsx angle bracket is not a cast
 * @param {any} ts the compiler
 * @returns {{start: number, end: number}[]}
 */
function findSpecifiersTypeScript(source, fileName, ts) {
    const sourceFile = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.Latest,
        true,
        fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    /** @type {{start: number, end: number}[]} */
    const found = [];
    const take = (node) => found.push({ start: node.getStart(sourceFile), end: node.getEnd() });

    const visit = (node) => {
        // import express from "express", import type { Request } from "express", export * from it.
        // A type-only import is rewritten too: the types come from the new package as well.
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            node.moduleSpecifier.text === FROM
        ) {
            take(node.moduleSpecifier);
        } else if (
            // import express = require("express"), which is TypeScript's own spelling
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference) &&
            ts.isStringLiteral(node.moduleReference.expression) &&
            node.moduleReference.expression.text === FROM
        ) {
            take(node.moduleReference.expression);
        } else if (ts.isCallExpression(node)) {
            const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const arg = node.arguments[0];
            if ((isRequire || isDynamicImport) && arg && ts.isStringLiteral(arg) && arg.text === FROM) {
                take(arg);
            }
        }
        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return found;
}

/**
 * The string literals naming the module, found through the parser rather than by searching the
 * text. "express" appears inside express-session, inside comments and inside strings that are not
 * imports at all, and none of those may be rewritten.
 *
 * @param {string} source
 * @returns {{start: number, end: number}[]|null} null when the file does not parse
 */
function findSpecifiers(source) {
    /** @type {any} */
    let tree;
    // A file is either a module or a script and the parser has to be told which. Try module first,
    // since it also accepts everything a script can contain except a bare `return`.
    for (const sourceType of ["module", "script"]) {
        try {
            tree = acorn.parse(source, {
                ecmaVersion: "latest",
                sourceType: /** @type {any} */ (sourceType),
                allowReturnOutsideFunction: true,
                allowAwaitOutsideFunction: true,
                allowHashBang: true
            });
            break;
        } catch {
            tree = null;
        }
    }
    if (!tree) {
        return null;
    }

    /** @type {{start: number, end: number}[]} */
    const found = [];
    walk(tree, (node) => {
        // import express from "express", export * from "express"
        if (
            (node.type === "ImportDeclaration" ||
                node.type === "ExportNamedDeclaration" ||
                node.type === "ExportAllDeclaration") &&
            node.source?.value === FROM
        ) {
            found.push({ start: node.source.start, end: node.source.end });
            return;
        }
        // require("express") and import("express"), the second being a node of its own
        const isRequire =
            node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require";
        const isDynamicImport = node.type === "ImportExpression";
        if (isRequire || isDynamicImport) {
            const arg = isDynamicImport ? node.source : node.arguments?.[0];
            if (arg?.type === "Literal" && arg.value === FROM) {
                found.push({ start: arg.start, end: arg.end });
            }
        }
    });
    return found;
}

/**
 * Visits every node. acorn produces plain objects, so the shape is walked rather than dispatched
 * on: a table of node types would have to be kept in step with the parser, and being out of step
 * would mean silently skipping an import.
 * @param {any} node
 * @param {(node: any) => void} visit
 */
function walk(node, visit) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
        for (const child of node) walk(child, visit);
        return;
    }
    if (typeof node.type === "string") visit(node);
    for (const key in node) {
        if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
        walk(node[key], visit);
    }
}

/**
 * @param {string[]} argv
 */
function main(argv) {
    const command = argv[0];
    if (command === "differences") {
        printDifferences();
        return 0;
    }
    if (command !== "migrate") {
        console.log(`Usage:
  npx ${TO} migrate [dir]    rewrite require("${FROM}") and import from "${FROM}" to "${TO}"
  npx ${TO} differences      print what behaves differently, without changing anything

Options:
  --dry-run                  say what would change and change nothing`);
        return command ? 1 : 0;
    }

    const dryRun = argv.includes("--dry-run");
    const target = path.resolve(argv.slice(1).find((arg) => !arg.startsWith("--")) ?? ".");
    if (!fs.existsSync(target)) {
        console.error(`${target} does not exist`);
        return 1;
    }

    const files = fs.statSync(target).isDirectory() ? collectFiles(target) : [target];
    let changedFiles = 0;
    let changedImports = 0;
    /** @type {string[]} */
    const unparsed = [];
    /** @type {string[]} */
    const needTypeScript = [];

    // resolved once, and only if there is anything to use it on
    const hasTypeScriptFiles = files.some((file) => TYPESCRIPT_EXTENSIONS.has(path.extname(file)));
    const ts = hasTypeScriptFiles ? loadTypeScript(target) : null;

    for (const file of files) {
        const source = fs.readFileSync(file, "utf8");
        // reading every file's AST to find nothing is the common case, so skip the ones that
        // cannot contain the specifier at all
        if (!source.includes(FROM)) continue;

        const isTypeScript = TYPESCRIPT_EXTENSIONS.has(path.extname(file));
        if (isTypeScript && !ts) {
            needTypeScript.push(path.relative(target, file));
            continue;
        }

        const specifiers = isTypeScript ? findSpecifiersTypeScript(source, file, ts) : findSpecifiers(source);
        if (specifiers === null) {
            unparsed.push(path.relative(target, file));
            continue;
        }
        if (!specifiers.length) continue;

        // right to left, so an earlier replacement does not move the offsets of a later one
        let rewritten = source;
        for (const { start, end } of specifiers.sort((a, b) => b.start - a.start)) {
            const quote = source[start];
            rewritten = rewritten.slice(0, start) + quote + TO + quote + rewritten.slice(end);
        }
        changedFiles++;
        changedImports += specifiers.length;
        console.log(`${dryRun ? "would rewrite" : "rewrote"} ${path.relative(target, file)} (${specifiers.length})`);
        if (!dryRun) fs.writeFileSync(file, rewritten);
    }

    if (unparsed.length) {
        console.log(`\n${unparsed.length} file(s) could not be parsed and were left alone:`);
        for (const file of unparsed) console.log(`  ${file}`);
    }

    if (needTypeScript.length) {
        console.log(
            `\n${needTypeScript.length} TypeScript file(s) were left alone: reading them needs the` +
                ` typescript package, and it is not installed here.\nInstall it and run this again,` +
                ` or rewrite these by hand:`
        );
        for (const file of needTypeScript) console.log(`  ${file}`);
    }

    console.log(
        `\n${dryRun ? "would rewrite" : "rewrote"} ${changedImports} import(s) in ${changedFiles} file(s) of ${files.length} scanned`
    );
    if (changedFiles) {
        console.log(`Remember to install it: npm install ${TO}`);
        printDifferences();
    }
    return 0;
}

/** Prints the list above, which is what migrate ends with and what the differences command prints alone. */
function printDifferences() {
    console.log(`\nWhat to check by hand, since no rewrite can find these for you:\n`);
    for (const [title, detail] of DIFFERENCES) {
        console.log(`  ${title}`);
        for (const line of detail.split("\n")) console.log(`    ${line}`);
        console.log("");
    }
}

if (require.main === module) {
    process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, findSpecifiers, collectFiles, DIFFERENCES };
