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

// The CLI:
//   migrate [dir]    rewrites the module specifier, then prints what behaves differently
//   profile [entry]  what listen() decided about each route: native, router and why, or compiled
//   verify [dir]     whether this machine, project and Dockerfile can run it, see src/verify.js
//   override [dir]   the package manager substitution for a framework requiring express itself
//   angular [dir]    angular.json's externalDependencies, see src/adopt.js
//   create <dir>     a new project: server, package.json, a Dockerfile that works, src/create.js
//   pnpm [dir]       the two lines pnpm needs before it installs this, see src/adopt.js

const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
// the same walk express.testing asserts on
const { collectRoutes } = require("./testing.js");
const { verify } = require("./verify.js");
const { override, angular, pnpm } = require("./adopt.js");
const { create } = require("./create.js");

/** @typedef {import("./application.js").Application} Application */
/** @typedef {import("./router-utils.js").RouteEntry} RouteEntry */

const FROM = "express";
const TO = "fulmine.js";

// modules this has a faster version of, reported and not rewritten: the replacement lives on the
// express import, which may not be in scope where these are required
const BUILT_IN_INSTEAD = {
    compression: "express.compression(), which takes the same options",
    "serve-static": "express.static()",
    "body-parser": "express.json(), express.urlencoded(), express.text(), express.raw()"
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".nyc_output", ".next"]);
const EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx"]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx"]);

// what a working Express 5 app can depend on and Fulmine answers differently, printed after a
// migration and by `npx fulmine differences`
const DIFFERENCES = [
    [
        "app.listen() returns the app, not an http.Server",
        "The app answers as one: instanceof http.Server is true, and close(), address(), listening,\n" +
            "getConnections(), ref(), unref() and setTimeout() are all there. What is missing is the plumbing\n" +
            "that carries node sockets, so nothing emits connection, request or upgrade, and a library that\n" +
            "serves its own protocol on the socket, socket.io being the usual one, wants app.uwsApp instead."
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
        "a compiled route keeps its connection header",
        "A handler simple enough to be read at registration time is answered natively, and a client\n" +
            "that sent Connection: close is still told keep-alive, though the socket does close. A\n" +
            "response that would carry a validator is never compiled, so conditional requests behave as\n" +
            'on Express. app.set("declarative responses", false) turns it off. A body with a piece of\n' +
            'the query or a route parameter in it is compiled only under app.set("declarative request\n' +
            'values", true), which takes the value as uWS reads it: undecoded, the first one, or none.'
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
 * Every source file under dir, skipping the directories nobody wants rewritten.
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
            continue;
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
 * A reader for the .ts files of the project being migrated, or null when it has no TypeScript. The
 * parser is the project's own compiler, not shipped here. typescript 7 (Go) publishes no parser,
 * only its scanner on an ESM subpath, so 7 gets a token walk and 6 keeps the tree.
 *
 * @param {string} target directory being migrated
 * @returns {((source: string, fileName: string, seen?: Set<string>) => {start: number, end: number}[])|null}
 */
function loadTypeScript(target) {
    /** @param {string} name */
    const load = (name) => require(require.resolve(name, { paths: [target, process.cwd()] }));

    try {
        const ts = load("typescript");
        if (typeof ts.createSourceFile === "function") {
            return (source, fileName, seen) => findSpecifiersTypeScript(source, fileName, ts, seen);
        }
    } catch {
        return null;
    }

    try {
        const { createScanner } = load("typescript/unstable/ast/scanner");
        const { LanguageVariant, SyntaxKind } = load("typescript/unstable/ast");
        // an unstable subpath: without EndOfFile the token loop would never stop
        if (SyntaxKind.EndOfFile === undefined) return null;
        const ts = { createScanner, LanguageVariant, SyntaxKind };
        return (source, fileName, seen) => findSpecifiersScanner(source, fileName, ts, seen);
    } catch {
        return null;
    }
}

/**
 * The same specifiers out of a TypeScript file, whose tree is not ESTree.
 *
 * @param {string} source
 * @param {string} fileName decides whether JSX is allowed
 * @param {typeof import("typescript")} ts the compiler
 * @param {Set<string>} [seen] as in findSpecifiers
 * @returns {{start: number, end: number}[]}
 */
function findSpecifiersTypeScript(source, fileName, ts, seen) {
    const sourceFile = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.Latest,
        true,
        fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    /** @type {{start: number, end: number}[]} */
    const found = [];
    /** @param {import("typescript").StringLiteral} node a string literal naming a module */
    const take = (node) => {
        if (node.text === FROM) {
            found.push({ start: node.getStart(sourceFile), end: node.getEnd() });
        } else if (seen && BUILT_IN_INSTEAD[node.text]) {
            seen.add(node.text);
        }
    };

    /** @param {import("typescript").Node} node */
    const visit = (node) => {
        // import, import type and export from: a type-only import is rewritten too
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            take(node.moduleSpecifier);
        } else if (
            // import express = require("express")
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference) &&
            ts.isStringLiteral(node.moduleReference.expression)
        ) {
            take(node.moduleReference.expression);
        } else if (ts.isCallExpression(node)) {
            const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const arg = node.arguments[0];
            if ((isRequire || isDynamicImport) && arg && ts.isStringLiteral(arg)) {
                take(arg);
            }
        }
        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return found;
}

/**
 * The same specifiers off typescript 7's token stream, which has no parser: comments and strings
 * that only look like imports are not tokens.
 *
 * @param {string} source
 * @param {string} fileName decides whether JSX is allowed
 * @param {any} ts the scanner and the two enums, from the unstable API the typings do not describe
 * @param {Set<string>} [seen] as in findSpecifiers
 * @returns {{start: number, end: number}[]}
 */
function findSpecifiersScanner(source, fileName, ts, seen) {
    const kind = ts.SyntaxKind;
    const scanner = ts.createScanner(
        true,
        fileName.endsWith(".tsx") ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
        source
    );

    /** @type {{start: number, end: number}[]} */
    const found = [];
    // the three tokens before the one in hand, newest first
    let back1 = -1;
    let back2 = -1;
    let back3 = -1;

    for (let token = scanner.scan(); token !== kind.EndOfFile; token = scanner.scan()) {
        // from "express", import("express"), require("express"); not obj.require("express")
        const isFrom = back1 === kind.FromKeyword;
        const isRequire = back2 === kind.RequireKeyword && back3 !== kind.DotToken && back3 !== kind.QuestionDotToken;
        const isCall = back1 === kind.OpenParenToken && (back2 === kind.ImportKeyword || isRequire);
        if (token === kind.StringLiteral && (isFrom || isCall)) {
            const text = scanner.getTokenValue();
            if (text === FROM) {
                found.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd() });
            } else if (seen && BUILT_IN_INSTEAD[text]) {
                seen.add(text);
            }
        }
        back3 = back2;
        back2 = back1;
        back1 = token;
    }
    return found;
}

/**
 * The string literals naming the module, through the parser: "express" also appears in
 * express-session, in comments and in other strings.
 *
 * @param {string} source
 * @param {Set<string>} [seen] collects the modules with something built in here
 * @returns {{start: number, end: number}[]|null} null when the file does not parse
 */
function findSpecifiers(source, seen) {
    /** @type {import("acorn").Program|null|undefined} */
    let tree;
    // module first, it accepts everything a script can but a bare `return`
    for (const sourceType of ["module", "script"]) {
        try {
            tree = acorn.parse(source, {
                ecmaVersion: "latest",
                sourceType: /** @type {"module"|"script"} */ (sourceType),
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
    /** @param {import("acorn").Literal & {value: string}} node a string literal naming a module */
    const record = (node) => {
        if (node.value === FROM) {
            found.push({ start: node.start, end: node.end });
        } else if (seen && BUILT_IN_INSTEAD[node.value]) {
            seen.add(node.value);
        }
    };
    walk(tree, (node) => {
        if (
            (node.type === "ImportDeclaration" ||
                node.type === "ExportNamedDeclaration" ||
                node.type === "ExportAllDeclaration") &&
            typeof node.source?.value === "string"
        ) {
            record(node.source);
            return;
        }
        const isRequire =
            node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require";
        const isDynamicImport = node.type === "ImportExpression";
        if (isRequire || isDynamicImport) {
            const arg = isDynamicImport ? node.source : node.arguments?.[0];
            if (arg?.type === "Literal" && typeof arg.value === "string") {
                record(arg);
            }
        }
    });
    return found;
}

/**
 * Visits every node by key rather than by a table of node types, which could skip an import.
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

/** Where an application usually is. */
const DEFAULT_ENTRIES = ["server.js", "app.js", "index.js", "src/server.js", "src/app.js", "src/index.js"];

/**
 * The file a start script runs node on: a service's entry is more often here than in "main".
 *
 * @param {unknown} script the "start" script, as package.json wrote it
 * @returns {string|null}
 */
function entryFromScript(script) {
    if (typeof script !== "string") {
        return null;
    }
    const words = script.split(/\s+/).filter(Boolean);
    if (!/^(node|nodejs)$/.test(path.basename(words[0] ?? "", ".exe"))) {
        // ts-node, nodemon, a shell pipeline
        return null;
    }
    for (const word of words.slice(1)) {
        if (word.startsWith("-")) {
            continue;
        }
        const candidate = path.resolve(word);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
        break;
    }
    return null;
}

/**
 * The file to load: the argument, package.json's main or start script, or the usual names.
 *
 * @param {string|undefined} given
 * @returns {string|null}
 */
function findEntry(given) {
    if (given) {
        const resolved = path.resolve(given);
        return fs.existsSync(resolved) ? resolved : null;
    }
    try {
        const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
        if (pkg.main && fs.existsSync(path.resolve(pkg.main))) {
            return path.resolve(pkg.main);
        }
        // a main naming a file nobody built, dist/server.js, is no main
        const started = entryFromScript(pkg.scripts?.start);
        if (started) {
            return started;
        }
    } catch {
        // no package.json, or one that will not parse
    }
    for (const name of DEFAULT_ENTRIES) {
        const resolved = path.resolve(name);
        if (fs.existsSync(resolved)) {
            return resolved;
        }
    }
    return null;
}

/**
 * Every copy of this library the application could load, as the prototype that owns listen(): a
 * global install, `npx fulmine.js@version` or an override can resolve a copy other than this
 * command's, and patching only this one would leave the application's listen() to bind the port.
 *
 * @param {string} entry
 * @returns {Application[]} the prototypes to stub, this command's copy first
 */
function listenOwners(entry) {
    const builds = new Set([require("./index.js")]);
    for (const specifier of [TO, FROM]) {
        try {
            builds.add(require(require.resolve(specifier, { paths: [path.dirname(entry), process.cwd()] })));
        } catch {
            // not installed next to the application
        }
    }

    /** @type {Application[]} */
    const owners = [];
    for (const build of builds) {
        if (typeof build !== "function") {
            continue;
        }
        let app;
        try {
            app = build();
        } catch {
            continue;
        }
        // real express resolves under the same names
        if (typeof app._compileOptimizedRoutes !== "function") {
            continue;
        }
        let proto = Object.getPrototypeOf(app);
        while (proto && !Object.prototype.hasOwnProperty.call(proto, "listen")) {
            proto = Object.getPrototypeOf(proto);
        }
        if (proto && !owners.includes(proto)) {
            owners.push(proto);
        }
    }
    return owners;
}

/**
 * The applications a file builds, compiled but not listening: listen() is replaced by the half
 * that compiles the routes, and its callback is not run.
 *
 * @param {string[]} argv
 * @param {string} command the word for the message when there is nothing to load
 * @returns {{apps: Application[], entry: string}|null} null once the reason has been printed
 */
function loadApps(argv, command) {
    const entry = findEntry(argv.find((arg) => !arg.startsWith("--")));
    if (!entry) {
        console.error(
            `Nothing to ${command}: name the file that builds the application, or run this from a
` + "directory whose package.json main or start script points at it."
        );
        return null;
    }

    const owners = listenOwners(entry);
    if (owners.length === 0) {
        console.error("This build of fulmine has no listen() to stand in for, which should not happen.");
        return null;
    }

    /** @type {Application[]} */
    const listened = [];
    const real = owners.map((proto) => proto.listen);
    for (const proto of owners) {
        proto.listen = function stubbedListen() {
            this._compileOptimizedRoutes();
            listened.push(this);
            return this;
        };
    }
    const restore = () => owners.forEach((proto, i) => (proto.listen = real[i]));

    try {
        require(entry);
    } catch (e) {
        const error = /** @type {Error} */ (e);
        restore();
        console.error(`${path.relative(process.cwd(), entry)} could not be loaded:
${error.stack ?? error}`);
        return null;
    }
    restore();

    let apps = listened;
    if (apps.length === 0) {
        // an application that exports itself rather than listening
        const exported = require(entry);
        const candidate = exported?.default ?? exported?.app ?? exported;
        if (candidate && Array.isArray(candidate._routes)) {
            candidate._compileOptimizedRoutes();
            apps = [candidate];
        }
    }

    if (apps.length === 0) {
        console.error(
            `${path.relative(process.cwd(), entry)} built no application: it neither called listen() nor
` +
                `exported one. Point this at the file that does. A listen() that runs after an await is
` +
                "not seen either, since this loads the file rather than waiting on what it started."
        );
        return null;
    }
    stopFileWorkers(apps);
    return { apps, entry };
}

/**
 * Ends the file-reading threads that building an application started. They are unref'd, but they
 * hold the loaded library and outlive the directory it came from: a test that profiled a copy and
 * removed it saw "Cannot find module .../src/worker.js". Best effort, a worker already gone is fine.
 *
 * @param {Application[]} apps
 * @returns {void}
 */
function stopFileWorkers(apps) {
    const seen = new Set();
    for (const app of apps) {
        for (const holder of app?.workers ?? []) {
            const worker = holder?.worker;
            if (!worker || seen.has(worker)) {
                continue;
            }
            seen.add(worker);
            try {
                worker.terminate();
            } catch {
                // already gone
            }
        }
    }
}

/**
 * Loads an application without letting it listen and prints what compiling its routes decided.
 *
 * @param {string[]} argv
 * @returns {number} exit code
 */
function profile(argv) {
    const loaded = loadApps(argv, "profile");
    if (!loaded) {
        return 1;
    }
    for (const app of loaded.apps) {
        printProfile(app, loaded.apps.length > 1);
    }
    return 0;
}

// what a reason means for whoever wrote the route, only where they can act on it
/** @type {[RegExp, (match: RegExpExecArray) => string][]} */
const ADVICE = [
    [
        /^the parameter route (.+) is written before it$/,
        (match) =>
            `write it above ${match[1]}. Express answers whichever matches first, so the order is` +
            ` already what decides,\n    and with the literal first µWS can match it in C++ as well.`
    ],
    [
        /^something before it in the same router overlaps its paths$/,
        () =>
            "something registered earlier answers some of the same paths, so the chain that would" +
            " reach this route\n    cannot be worked out ahead of time. Narrowing the earlier path, or moving this one above it, frees it."
    ],
    [
        /^a route after it in the same mounted router could answer the same paths$/,
        () =>
            "a route below it in the same mounted router overlaps it. Inside a mount the later one" +
            " has to be able to win,\n    which a precomputed chain cannot express. Narrowing either path frees it."
    ]
];

/**
 * The plan for one route, as a database explains a query: how it is matched, what is copied out
 * of the request, what runs.
 *
 * @param {string[]} argv the path to explain, then the entry
 * @returns {number} exit code
 */
function explain(argv) {
    const args = argv.filter((arg) => !arg.startsWith("--"));
    const wanted = args[0];
    if (!wanted) {
        console.error(`Name the route to explain: npx ${TO} explain /api/items`);
        return 1;
    }
    const loaded = loadApps(args.slice(1), "explain");
    if (!loaded) {
        return 1;
    }

    const { callbackUsage, UNKNOWN, QUERY } = require("./usage.js");
    let found = 0;
    for (const app of loaded.apps) {
        const entries = collectRoutes(app, "").filter(({ route }) => !route.use);
        for (const { route, full } of entries) {
            if (!matchesWanted(full, route.method, wanted)) {
                continue;
            }
            found++;
            const native = route._native;
            console.log(`
${String(route.method).toUpperCase()} ${full}
`);
            console.log(
                `  route      ${native ? `native (µWS matched ${native.path} and dispatched by method)` : `router (matched here, layer by layer: ${route._whyGeneric ?? "it was not eligible"})`}`
            );
            if (native) {
                console.log(
                    `  headers    ${native.skipHeaders ? "not copied (nothing in the chain reads one)" : "copied out of µWS (something in the chain reads them)"}`
                );
                console.log(
                    `  query      ${native.skipQuery ? "not parsed (nothing in the chain reads it)" : "parsed when something asks for it"}`
                );
                if (native.guards) {
                    console.log(`  guards     ${native.guards} case guard(s) in front of it`);
                }
            }

            const chain = route.callbacks ?? [];
            const ahead = native?.ahead ? `, ${native.ahead} mounted layer(s) in front of it` : "";
            console.log(
                `  chain      ${chain.length} layer(s)${ahead}${native?.declarative ? ", compiled into a response written at startup" : ""}`
            );
            for (const fn of chain) {
                const usage = callbackUsage(fn);
                const name = fn.name || "(anonymous)";
                const notes = [];
                if (usage & UNKNOWN) {
                    notes.push("not readable at registration: it keeps the route off the compiled path");
                } else {
                    notes.push("readable at registration");
                    if (usage & QUERY) notes.push("reads the query");
                }
                console.log(`    ${name.padEnd(22)}${notes.join(", ")}`);
            }
            console.log(
                `  body       ${route.bodyMethods ? `read for ${route.bodyMethods.join(", ")}` : "read for POST, PUT, PATCH and QUERY, when one is declared"}`
            );
        }
    }

    if (found === 0) {
        console.error(`No route is registered as "${wanted}". Run \`npx ${TO} profile\` to see the ones that are.`);
        return 1;
    }
    return 0;
}

/**
 * Whether a route answers to the name given: the registered path, an optional method in front,
 * an optional "*" at the end.
 *
 * @param {string} full
 * @param {string} method
 * @param {string} wanted
 * @returns {boolean}
 */
function matchesWanted(full, method, wanted) {
    let path = wanted;
    const space = wanted.indexOf(" ");
    if (space !== -1) {
        if (wanted.slice(0, space).toUpperCase() !== String(method).toUpperCase()) {
            return false;
        }
        path = wanted.slice(space + 1);
    }
    return path.endsWith("*") ? full.startsWith(path.slice(0, -1)) : full === path;
}

/**
 * How much of the application the native router carries and what could change that. No score: a
 * percentage of routes is not a percentage of traffic.
 *
 * @param {{route: RouteEntry, full: string}[]} routes
 * @param {{route: RouteEntry, full: string}[]} native
 * @param {{route: RouteEntry, full: string}[]} declarative
 */
function printSummary(routes, native, declarative) {
    console.log("\nWhat this adds up to\n");
    console.log(`  ${native.length} of ${routes.length} route(s) matched by µWS in C++`);
    if (declarative.length > 0) {
        console.log(`  ${declarative.length} answered from a response written at startup, running no javascript`);
    }

    const skipHeaders = native.filter(({ route }) => route._native.skipHeaders).length;
    const skipQuery = native.filter(({ route }) => route._native.skipQuery).length;
    if (skipHeaders || skipQuery) {
        console.log(
            `  ${skipHeaders} copy no request headers, ${skipQuery} read no query: the analysis proved nothing asks for them`
        );
    }

    if (native.length > 0) {
        const ahead = native.map(({ route }) => route._native.ahead);
        const total = ahead.reduce((sum, n) => sum + n, 0);
        console.log(
            `  layers in front of a compiled handler: ${Math.min(...ahead)} at least, ${Math.max(...ahead)} at most,` +
                ` ${(total / ahead.length).toFixed(1)} on average`
        );
    }

    const worth = [];
    for (const { route, full } of routes) {
        if (route._native || !route._whyGeneric) continue;
        for (const [pattern, say] of ADVICE) {
            const match = pattern.exec(route._whyGeneric);
            if (match) {
                worth.push(`  ${route.method} ${full}\n    ${say(match)}`);
                break;
            }
        }
    }
    if (worth.length > 0) {
        console.log(`\nWorth changing, if these are routes that carry traffic\n`);
        console.log(worth.join("\n\n"));
    }
}

/**
 * @param {Application} app the application the entry file built
 * @param {boolean} several whether to say which application this is
 */
function printProfile(app, several) {
    const entries = collectRoutes(app, "");
    const routes = entries.filter(({ route }) => !route.use);
    const mounts = entries.filter(({ route }) => route.use);
    const native = routes.filter(({ route }) => route._native);
    const declarative = native.filter(({ route }) => route._native.declarative);

    if (several) {
        console.log(`\n=== an application listening on ${app._listenHost ?? "its own port"} ===`);
    }
    console.log(
        `\n${routes.length} route(s), ${native.length} answered by µWS itself` +
            `${declarative.length ? `, ${declarative.length} of them without running any javascript` : ""}\n`
    );

    for (const { route, full } of routes) {
        const method = String(route.method).padEnd(7);
        const where = full.padEnd(34);
        if (route._native) {
            const notes = [];
            if (route._native.declarative) notes.push("compiled to a response");
            if (route._native.ahead) notes.push(`${route._native.ahead} in front of it in its chain`);
            if (route._native.guards) notes.push(`${route._native.guards} case guard(s)`);
            if (route._native.skipHeaders) notes.push("copies no request headers");
            if (route._native.skipQuery) notes.push("reads no query");
            console.log(
                `  ${method}${where}µWS  ${route._native.path}${notes.length ? `  (${notes.join(", ")})` : ""}`
            );
        } else {
            console.log(`  ${method}${where}router: ${route._whyGeneric ?? "it was not eligible"}`);
        }
    }

    // only a mount holding a router could have been walked into, the rest is middleware
    const routers = mounts.filter(
        ({ route }) => route.callbacks?.length === 1 && Array.isArray(route.callbacks[0]?._routes)
    );
    const missed = routers.filter(({ route }) => !route._walkedInto);
    if (missed.length > 0) {
        console.log(`\n${missed.length} mounted router(s) the compiler did not walk into:\n`);
        for (const { route, full } of missed) {
            console.log(`  ${(full || "/").padEnd(40)}${route._whyGeneric ?? "it was not eligible"}`);
        }
    }

    const middleware = mounts.length - routers.length;
    if (middleware > 0) {
        console.log(
            `\n${middleware} middleware in front of them. Every request walks the ones whose path it` +
                ` matches,\nand a compiled route walks them from a list worked out at startup rather than by matching.`
        );
    }

    printSummary(routes, native, declarative);

    console.log(
        "\nA route answered by µWS is matched in C++ and reaches javascript with its chain already\n" +
            "known. One that fell back is matched here, in order, the way Express does it: correct\n" +
            "either way, and the reason is printed so it can be changed if it is worth changing.\n" +
            "The server was not started and its listen callback was not run."
    );
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
    if (command === "profile") {
        return profile(argv.slice(1));
    }
    if (command === "verify") {
        return verify(argv.slice(1));
    }
    if (command === "explain") {
        return explain(argv.slice(1));
    }
    if (command === "override") {
        return override(argv.slice(1));
    }
    if (command === "angular") {
        return angular(argv.slice(1));
    }
    if (command === "create") {
        return create(argv.slice(1));
    }
    if (command === "pnpm") {
        return pnpm(argv.slice(1));
    }
    if (command !== "migrate") {
        console.log(`Usage:
  npx ${TO} create <dir>       start a new project: a server, a package.json and a Dockerfile that
                               works, --ts for TypeScript, --pnpm for the two lines pnpm needs
  npx ${TO} migrate [dir]      rewrite require("${FROM}") and import from "${FROM}" to "${TO}"
  npx ${TO} override [dir]     answer ${FROM} with this package for the whole dependency tree, for
                               when a framework requires ${FROM} in its own code and not in yours
  npx ${TO} angular [dir]      declare this package external in angular.json's server build, which
                               esbuild otherwise tries to inline a native binary into
  npx ${TO} pnpm [dir]         make a pnpm project install this: pnpm 10.26 and later refuse a git
                               dependency of a dependency, and µWebSockets.js is one
  npx ${TO} profile [entry]    load an application without listening and print what compiling
                               its routes decided, route by route
  npx ${TO} explain <route>    what happens when a request for that route arrives
  npx ${TO} verify [dir]       check that this machine and this project can run it at all
  npx ${TO} differences        print what behaves differently, without changing anything

Options:
  --dry-run                    migrate, override, angular, pnpm: say what would change and change nothing`);
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
    /** @type {Set<string>} */
    const builtInInstead = new Set();

    const hasTypeScriptFiles = files.some((file) => TYPESCRIPT_EXTENSIONS.has(path.extname(file)));
    const readTypeScript = hasTypeScriptFiles ? loadTypeScript(target) : null;

    for (const file of files) {
        const source = fs.readFileSync(file, "utf8");
        // most files contain none of the names, no need to parse them
        if (!source.includes(FROM) && !Object.keys(BUILT_IN_INSTEAD).some((name) => source.includes(name))) continue;

        const isTypeScript = TYPESCRIPT_EXTENSIONS.has(path.extname(file));
        if (isTypeScript && !readTypeScript) {
            needTypeScript.push(path.relative(target, file));
            continue;
        }

        const specifiers =
            isTypeScript && readTypeScript
                ? readTypeScript(source, file, builtInInstead)
                : findSpecifiers(source, builtInInstead);
        if (specifiers === null) {
            unparsed.push(path.relative(target, file));
            continue;
        }
        if (!specifiers.length) continue;

        // right to left, so the offsets hold
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

    // said whether or not anything was rewritten, an application migrated last month still has these
    if (builtInInstead.size) {
        console.log(`\n${builtInInstead.size} module(s) with a faster one built in here, worth replacing by hand:`);
        for (const name of builtInInstead) {
            console.log(`  ${name} -> ${BUILT_IN_INSTEAD[name]}`);
        }
        console.log("");
    }

    if (changedFiles) {
        console.log(`Remember to install it: npm install ${TO}`);
        printDifferences();
    }
    return 0;
}

/** What migrate ends with and the differences command prints alone. */
function printDifferences() {
    console.log(`\nWhat to check by hand, since no rewrite can find these for you:\n`);
    for (const [title, detail] of DIFFERENCES) {
        console.log(`  ${title}`);
        for (const line of detail.split("\n")) console.log(`    ${line}`);
        console.log("");
    }
}

if (require.main === module) {
    const code = main(process.argv.slice(2));
    if (process.argv[2] === "profile") {
        // the loaded application may hold a database handle or a timer open; only here, so the
        // command stays a function a test can call
        process.exit(code);
    }
    process.exitCode = code;
}

module.exports = { main, findSpecifiers, collectFiles, findEntry, collectRoutes, profile, DIFFERENCES };
