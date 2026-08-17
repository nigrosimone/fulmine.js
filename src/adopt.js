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

// The two commands that edit a config file rather than source: `npx fulmine.js override` and
// `npx fulmine.js angular`.
//
// `migrate` rewrites `require("express")` in your own files, which is all an application needs. The
// two cases it cannot reach are both a line in a JSON file that nobody remembers the shape of:
//
//   override   A framework built on Express does not require it in your code, it requires it in its
//              own, so there is no specifier to rewrite. Every package manager can answer `express`
//              with this package instead, for the whole tree, and each one spells it differently.
//   angular    An Angular server bundle is built with esbuild, which inlines every dependency and
//              cannot load µWS's native binary. Two names in `externalDependencies` fix it, and
//              nothing in the error message it fails with says so.

"use strict";

const fs = require("fs");
const path = require("path");

const SELF = "fulmine.js";
const REPLACES = "express";

/** The major this package tracks, which is the range an override should ask for. */
const MAJOR = require("../package.json").version.split(".")[0];

/** Where each manager keeps its substitutions, and what to call it when telling someone. */
const MANAGERS = {
    npm: { keys: ["overrides"], reinstall: "npm install" },
    pnpm: { keys: ["pnpm", "overrides"], reinstall: "pnpm install" },
    yarn: { keys: ["resolutions"], reinstall: "yarn install" }
};

/** A lockfile, and the manager that wrote it. bun is here to be refused, see detectManager. */
const LOCKFILES = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"]
];

/**
 * The indentation a file already uses, so rewriting it does not reformat every line.
 *
 * @param {string} source
 * @returns {string|number} what JSON.stringify takes as its third argument
 */
function indentOf(source) {
    const first = source.match(/\n([ \t]+)"/);
    if (!first) {
        return 4;
    }
    return first[1].startsWith("\t") ? "\t" : first[1].length;
}

/**
 * Reads a JSON file, or explains why it could not be read rather than throwing a parser error.
 *
 * The read is attempted rather than guarded by an existence check. Both commands go on to write the
 * file they read, and a check on a path followed by a write to the same path is the shape of a race
 * whatever the odds of losing it. `code` is what a caller names the missing file by.
 *
 * @param {string} file
 * @returns {{data: any, source: string}|{error: string, code: string|undefined}}
 */
function readJson(file) {
    let source;
    try {
        source = fs.readFileSync(file, "utf8");
    } catch (e) {
        const err = /** @type {NodeJS.ErrnoException} */ (e);
        return { error: `${file} could not be read: ${err.message}`, code: err.code };
    }
    try {
        return { data: JSON.parse(source), source };
    } catch (e) {
        const err = /** @type {Error} */ (e);
        return { error: `${file} is not valid JSON and was left alone: ${err.message}`, code: undefined };
    }
}

/**
 * Which package manager this project uses.
 *
 * The `packageManager` field is asked first: a project that declares one is using it whatever
 * lockfiles are lying around. A project with neither gets npm, since that is what `npx` came with.
 *
 * @param {string} dir
 * @param {any} pkg the parsed package.json
 * @returns {{manager: string, why: string}}
 */
function detectManager(dir, pkg) {
    const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
    if (declared && (MANAGERS[declared] || declared === "bun")) {
        return { manager: declared, why: `the packageManager field says ${declared}` };
    }
    for (const [file, manager] of LOCKFILES) {
        if (fs.existsSync(path.join(dir, file))) {
            return { manager, why: `${file} is here` };
        }
    }
    return { manager: "npm", why: "no lockfile and no packageManager field, so npm" };
}

/**
 * Reads a nested key, and answers undefined rather than throwing on a missing level.
 *
 * @param {any} object
 * @param {string[]} keys
 * @returns {any}
 */
function readPath(object, keys) {
    let at = object;
    for (const key of keys) {
        if (at === null || typeof at !== "object") return undefined;
        at = at[key];
    }
    return at;
}

/**
 * Writes a nested key, making the levels above it as it goes.
 *
 * @param {any} object
 * @param {string[]} keys
 * @param {any} value
 * @returns {void}
 */
function writePath(object, keys, value) {
    let at = object;
    for (const key of keys.slice(0, -1)) {
        if (at[key] === null || typeof at[key] !== "object") at[key] = {};
        at = at[key];
    }
    at[keys[keys.length - 1]] = value;
}

/**
 * npx fulmine.js override [dir] [--dry-run]
 *
 * Puts the substitution in package.json where this project's package manager reads it, and says
 * what to run next. It deliberately does not run the install: the reinstall throws away
 * node_modules, and that is not something a command should do to somebody's working tree without
 * being watched.
 *
 * @param {string[]} argv everything after the command name
 * @returns {number} exit code
 */
function override(argv) {
    const dryRun = argv.includes("--dry-run");
    const dir = path.resolve(argv.find((arg) => !arg.startsWith("--")) ?? ".");
    const file = path.join(dir, "package.json");

    const read = readJson(file);
    if ("error" in read) {
        console.error(read.code === "ENOENT" ? `no package.json in ${dir}` : read.error);
        return 1;
    }
    const { data: pkg, source } = read;

    const { manager, why } = detectManager(dir, pkg);
    if (manager === "bun") {
        console.error(
            `this project uses bun (${why}), and bun cannot run this package at all: µWebSockets.js\n` +
                "is a native node addon and bun does not load it. Nothing was changed."
        );
        return 1;
    }

    const { keys, reinstall } = MANAGERS[manager];
    const where = keys.join(".");
    const wanted = `npm:${SELF}@^${MAJOR}`;

    const existing = readPath(pkg, [...keys, REPLACES]);
    if (existing === wanted) {
        console.log(`${where}.${REPLACES} already says ${wanted}, so there is nothing to change.`);
        console.log(`Check it took: ${manager === "npm" ? "npm ls express" : `${manager} why express`}`);
        return 0;
    }
    if (existing !== undefined) {
        console.error(
            `${where}.${REPLACES} already says ${JSON.stringify(existing)}, which is not this package.\n` +
                "Nothing was changed: overwriting somebody else's substitution is not this command's call."
        );
        return 1;
    }

    writePath(pkg, [...keys, REPLACES], wanted);
    const rewritten = JSON.stringify(pkg, null, indentOf(source)) + "\n";

    // the block on its own, so what was added can be read without diffing a whole package.json
    const shown = {};
    writePath(shown, keys, { [REPLACES]: wanted });
    console.log(`${manager}, because ${why}`);
    console.log(`${dryRun ? "would add" : "added"} to package.json:\n`);
    console.log(
        JSON.stringify(shown, null, 2)
            .split("\n")
            .map((line) => `  ${line}`)
            .join("\n") + "\n"
    );
    if (!dryRun) {
        fs.writeFileSync(file, rewritten);
    }

    console.log("Then reinstall, so the lockfile is written again:\n");
    console.log(`  rm -rf node_modules && ${reinstall}\n`);
    const check = manager === "npm" ? "npm ls express" : `${manager} why express`;
    console.log(`It took when \`${check}\` names ${SELF}.\n`);
    console.log("Two things to know before you trust it:\n");
    console.log(`  The substitution reaches every dependency that asks for ${REPLACES}, including ones you have`);
    console.log("  never looked at. Run your own tests afterwards, and read `npx fulmine.js differences`:");
    console.log("  what a framework does with Express is usually more than what an application does.\n");
    console.log(`  A package that reaches into ${REPLACES}/lib/... rather than its public surface will not find`);
    console.log("  what it expects, since the files there are ours.\n");
    return 0;
}

/**
 * Every build target in an angular.json that produces a server bundle.
 *
 * A browser-only build has nothing to declare external: the bundle it makes never loads µWS. What
 * marks a server build is `ssr`, `server` or `outputMode` in its options, which is what `ng add
 * @angular/ssr` writes.
 *
 * @param {any} config the parsed angular.json
 * @returns {{name: string, options: any}[]}
 */
function serverBuilds(config) {
    const found = [];
    for (const [name, project] of Object.entries(config.projects ?? {})) {
        const targets = readPath(project, ["architect"]) ?? readPath(project, ["targets"]);
        const options = readPath(targets, ["build", "options"]);
        if (!options || typeof options !== "object") continue;
        if (options.ssr === undefined && options.server === undefined && options.outputMode === undefined) continue;
        found.push({ name, options });
    }
    return found;
}

/**
 * npx fulmine.js angular [dir] [--dry-run]
 *
 * Declares this package and µWebSockets.js external in every server build, which is what stops
 * esbuild trying to inline a native binary it cannot read.
 *
 * @param {string[]} argv everything after the command name
 * @returns {number} exit code
 */
function angular(argv) {
    const dryRun = argv.includes("--dry-run");
    const given = path.resolve(argv.find((arg) => !arg.startsWith("--")) ?? ".");
    // one stat and not an existence check followed by one: the argument may be the file itself or
    // the directory holding it, and nothing is missing if it is neither
    const stat = fs.statSync(given, { throwIfNoEntry: false });
    const file = stat?.isFile() ? given : path.join(given, "angular.json");

    const read = readJson(file);
    if ("error" in read) {
        console.error(read.code === "ENOENT" ? `no angular.json at ${file}` : read.error);
        return 1;
    }
    const { data: config, source } = read;

    const builds = serverBuilds(config);
    if (!builds.length) {
        console.error(
            "no server build in angular.json: every build target here produces a browser bundle, and a\n" +
                "browser bundle never loads µWebSockets.js. Nothing to declare external, and nothing changed.\n" +
                "Run `ng add @angular/ssr` first if this application is meant to render on the server."
        );
        return 1;
    }

    let changed = 0;
    for (const { name, options } of builds) {
        const external = Array.isArray(options.externalDependencies) ? options.externalDependencies : [];
        const missing = [SELF, "uWebSockets.js"].filter((one) => !external.includes(one));
        if (!missing.length) {
            console.log(`${name}: already external, nothing to change`);
            continue;
        }
        options.externalDependencies = [...external, ...missing];
        changed++;
        console.log(`${name}: ${dryRun ? "would declare" : "declared"} ${missing.join(" and ")} external`);
    }

    if (!changed) {
        return 0;
    }
    if (!dryRun) {
        fs.writeFileSync(file, JSON.stringify(config, null, indentOf(source)) + "\n");
    }

    console.log(`\n${dryRun ? "would rewrite" : "rewrote"} ${path.relative(process.cwd(), file) || file}\n`);
    console.log("The server.ts that `ng add @angular/ssr` generates is an ordinary Express application, so");
    console.log("`npx fulmine.js migrate` is what changes the import in it. @angular/ssr's own");
    console.log("AngularNodeAppEngine and writeResponseToNodeResponse work against this unchanged.\n");
    return 0;
}

module.exports = { override, angular, detectManager, serverBuilds, indentOf };
