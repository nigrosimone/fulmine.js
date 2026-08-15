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
//
// npx fulmine profile [entry]
//
// Prints what listen() worked out about each route and normally keeps to itself: which ones µWS
// answers on its own, which ones fell back to the ordinary router and why, and which ones were
// compiled all the way down to a response written at startup.
//
// npx fulmine verify [dir]
//
// Whether this machine and this project can run it at all: the node version, the C library, the
// µWebSockets.js binary, the base image a Dockerfile names. See src/verify.js.

const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
// the same walk express.testing asserts on, so the command and the assertions cannot drift
const { collectRoutes } = require("./testing.js");
const { verify } = require("./verify.js");

const FROM = "express";
const TO = "fulmine.js";

// Modules this has a faster version of, spotted while the files are being read anyway. They are
// reported and not rewritten: the replacement is reached through the express import, which this
// command cannot know is in scope in the file that requires them, and body-parser is four
// functions rather than one.
const BUILT_IN_INSTEAD = {
    compression: "express.compression(), which takes the same options",
    "serve-static": "express.static()",
    "body-parser": "express.json(), express.urlencoded(), express.text(), express.raw()"
};

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".nyc_output", ".next"]);
const EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx"]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx"]);

// Printed after a migration, and by `npx fulmine differences` on its own. Each one is something
// a working Express 5 app can depend on and that Fulmine answers differently.
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
        "a compiled route is framed differently and keeps its connection header",
        "A handler simple enough to be read at registration time is answered natively: chunked framing\n" +
            "with no Content-Length, and a client that sent Connection: close is still told keep-alive,\n" +
            "though the socket does close. A response that would carry a validator is never compiled, so\n" +
            'conditional requests behave as on Express. app.set("declarative responses", false) turns it off.'
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
    /** @param {any} node a string literal naming a module */
    const take = (node) => {
        if (node.text === FROM) {
            found.push({ start: node.getStart(sourceFile), end: node.getEnd() });
        } else if (seen && BUILT_IN_INSTEAD[node.text]) {
            seen.add(node.text);
        }
    };

    const visit = (node) => {
        // import express from "express", import type { Request } from "express", export * from it.
        // A type-only import is rewritten too: the types come from the new package as well.
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
        ) {
            take(node.moduleSpecifier);
        } else if (
            // import express = require("express"), which is TypeScript's own spelling
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
 * The string literals naming the module, found through the parser rather than by searching the
 * text. "express" appears inside express-session, inside comments and inside strings that are not
 * imports at all, and none of those may be rewritten.
 *
 * @param {string} source
 * @param {Set<string>} [seen] collects the names of the modules with something built in here,
 *   which are recognised on the same walk rather than on one of their own
 * @returns {{start: number, end: number}[]|null} null when the file does not parse
 */
function findSpecifiers(source, seen) {
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
    /** @param {any} node a string literal naming a module */
    const record = (node) => {
        if (node.value === FROM) {
            found.push({ start: node.start, end: node.end });
        } else if (seen && BUILT_IN_INSTEAD[node.value]) {
            seen.add(node.value);
        }
    };
    walk(tree, (node) => {
        // import express from "express", export * from "express"
        if (
            (node.type === "ImportDeclaration" ||
                node.type === "ExportNamedDeclaration" ||
                node.type === "ExportAllDeclaration") &&
            typeof node.source?.value === "string"
        ) {
            record(node.source);
            return;
        }
        // require("express") and import("express"), the second being a node of its own
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

/** Where an application usually is, when the command was given no entry to load. */
const DEFAULT_ENTRIES = ["server.js", "app.js", "index.js", "src/server.js", "src/app.js", "src/index.js"];

/**
 * The file a start script runs, when it runs node on one.
 *
 * "main" is about what a package exports, and a service usually exports nothing: the entry of a
 * deployed application is far more often the one written here, which is also the only place that
 * knows about a src/ or a bin/ the usual names do not cover.
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
        // ts-node, nodemon, a shell pipeline: what that runs is not a file this can load
        return null;
    }
    for (const word of words.slice(1)) {
        if (word.startsWith("-")) {
            continue; // --env-file=.env, --watch, and the rest of node's own flags
        }
        const candidate = path.resolve(word);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
        break; // the first thing that is not a flag is the file, and it is not there
    }
    return null;
}

/**
 * The file to load, from the argument, from package.json's main or start script, or from the
 * usual names.
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
        // a main that names a file nobody built, dist/server.js in a TypeScript project, is worth
        // no more than no main at all
        const started = entryFromScript(pkg.scripts?.start);
        if (started) {
            return started;
        }
    } catch {
        // no package.json, or one that will not parse: the usual names are still worth trying
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
 * Every build of this library the application could load, as the prototype that owns listen().
 *
 * The command runs from its own copy, and the application loads whichever one resolves from its
 * own directory. That is usually the same file and sometimes is not: a global install, an
 * `npx fulmine.js@version`, a workspace that hoisted a second copy, or the `express` name pointing
 * here through an override. Patching only this command's copy leaves the application's own listen()
 * to bind the port, and the command then reports that the file built nothing.
 *
 * An app is a callable, so its own prototype is not the one that carries the methods: walk up to
 * whichever link owns listen.
 *
 * @param {string} entry
 * @returns {any[]} the prototypes to stub, this command's copy first
 */
function listenOwners(entry) {
    const builds = new Set([require("./index.js")]);
    for (const specifier of [TO, FROM]) {
        try {
            builds.add(require(require.resolve(specifier, { paths: [path.dirname(entry), process.cwd()] })));
        } catch {
            // not installed next to the application, or not resolvable from there
        }
    }

    const owners = [];
    for (const build of builds) {
        if (typeof build !== "function") {
            continue;
        }
        let app;
        try {
            app = build();
        } catch {
            continue; // not an application factory, or one that will not build without arguments
        }
        // real express resolves under the same two names, and has none of this to stub
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
 * The applications a file builds, compiled but not listening.
 *
 * listen() is where the routes are compiled and also where the port is bound, and only the first
 * of those is wanted here: an application that answered on its port while being read would be a
 * surprise, and a second copy of a running service is worse than a surprise. So listen is replaced
 * by the half that matters, and the callback it was given is not run for the same reason.
 *
 * @param {string[]} argv
 * @param {string} command the word for the message when there is nothing to load
 * @returns {{apps: any[], entry: string}|null} null once the reason has been printed
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
        const error = /** @type {any} */ (e);
        restore();
        console.error(`${path.relative(process.cwd(), entry)} could not be loaded:
${error.stack ?? error}`);
        return null;
    }
    restore();

    let apps = listened;
    if (apps.length === 0) {
        // an application that exports itself rather than listening, which is how a testable one is
        // usually written. Compiling it here is the same work listen() would have done
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
 * Ends the file-reading threads that building an application started.
 *
 * An Application starts one per `threads` in its constructor, and these commands only ever read
 * what compiling the routes decided: nothing here serves a file, so nothing here needs a thread.
 * They are unref'd, so leaving them would not hang the process, but they are threads holding the
 * library the application loaded, and this command is often not the whole process. It also stops
 * them outliving the directory they were loaded from, which is how a test that profiles a copy and
 * then removes it saw "Cannot find module .../src/worker.js" arrive after it had finished.
 *
 * Best effort throughout: a build with no workers, or a worker already gone, is not an error here.
 *
 * @param {any[]} apps
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
                // a thread that never started, or already ended, needs nothing
            }
        }
    }
}

/**
 * Loads an application without letting it listen, and prints what compiling its routes decided.
 *
 * listen() is where the routes are compiled and also where the port is bound, and only the first
 * of those is wanted here: an application that answered on its port while being profiled would be
 * a surprise, and a second copy of a running service is worse than a surprise. So listen is
 * replaced by the half that matters. The callback it was given is not run, for the same reason.
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

// what a reason means for whoever wrote the route, when it means anything they can act on. A
// method µWS does not serve, or a path only a regular expression can match, is not something to
// go and fix; an ordering that costs the native match is.
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
 * The plan for one route, the way a database explains a query.
 *
 * `profile` answers "how much of this application is on the fast path", which is a question about
 * the whole table. This one answers "what happens when this request arrives", which is the question
 * somebody has when one endpoint is slower than they expected: how it is matched, what is copied
 * out of it, what runs, and what each layer costs the route.
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
 * Whether a route answers to the name given on the command line: the path as registered, with an
 * optional method in front and an optional "*" at the end for a prefix.
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
 * A summary that says how much of this application the native router carries, and what could be
 * changed to make it carry more.
 *
 * There is no score here on purpose. A percentage of routes is not a percentage of traffic: an
 * application with a thousand cold routes and one hot one that fell back would score well and
 * serve badly. What is printed instead is counted rather than judged, and the advice is only
 * printed for the reasons somebody can actually act on.
 *
 * @param {any[]} routes
 * @param {any[]} native
 * @param {any[]} declarative
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

    // the routes whose reason somebody can do something about
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
 * @param {any} app
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

    // a mount holding a router is one the compiler could have walked into; anything else is
    // middleware, and listing every helmet and cors as a mount that "was not walked into" says
    // nothing anyone can act on
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
    if (command !== "migrate") {
        console.log(`Usage:
  npx ${TO} migrate [dir]      rewrite require("${FROM}") and import from "${FROM}" to "${TO}"
  npx ${TO} profile [entry]    load an application without listening and print what compiling
                               its routes decided, route by route
  npx ${TO} explain <route>    what happens when a request for that route arrives
  npx ${TO} verify [dir]       check that this machine and this project can run it at all
  npx ${TO} differences        print what behaves differently, without changing anything

Options:
  --dry-run                    migrate: say what would change and change nothing`);
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

    // resolved once, and only if there is anything to use it on
    const hasTypeScriptFiles = files.some((file) => TYPESCRIPT_EXTENSIONS.has(path.extname(file)));
    const ts = hasTypeScriptFiles ? loadTypeScript(target) : null;

    for (const file of files) {
        const source = fs.readFileSync(file, "utf8");
        // reading every file's AST to find nothing is the common case, so skip the ones that
        // cannot contain any of the names being looked for
        if (!source.includes(FROM) && !Object.keys(BUILT_IN_INSTEAD).some((name) => source.includes(name))) continue;

        const isTypeScript = TYPESCRIPT_EXTENSIONS.has(path.extname(file));
        if (isTypeScript && !ts) {
            needTypeScript.push(path.relative(target, file));
            continue;
        }

        const specifiers = isTypeScript
            ? findSpecifiersTypeScript(source, file, ts, builtInInstead)
            : findSpecifiers(source, builtInInstead);
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

    // said whether or not anything was rewritten: an application migrated last month still has
    // these, and they are the difference between running on µWS and running through a middleware
    // that was written for node streams
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
    const code = main(process.argv.slice(2));
    if (process.argv[2] === "profile") {
        // profile loaded somebody's application, and loading it may have opened a database handle,
        // a timer or a µWS app of its own. None of that is ours to unwind, and there is nothing
        // left to print. Only here, so the command itself stays a function a test can call
        process.exit(code);
    }
    process.exitCode = code;
}

module.exports = { main, findSpecifiers, collectFiles, findEntry, collectRoutes, profile, DIFFERENCES };
