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

// µWebSockets.js loaded on first use, not at require: Angular's build imports server.ts in a
// worker thread and serves it through node's http, and on Windows the binary crashes the process
// when that thread exits (uNetworking/uWebSockets.js#668)

/** @type {any} */
let uWS;

// µWS is a native Node addon, Bun and Deno do not load it: there listen() serves through their
// node:http, as http.createServer(app) would
const otherRuntime = process.versions.bun ? "Bun" : process.versions.deno ? "Deno" : undefined;

/**
 * A project on pnpm owns the uWebSockets.js dependency itself, see `npx fulmine.js pnpm`, so the
 * one installed can drift from the one this package pins and was tested against. Said once, when
 * it is loaded: an app served through node's http never loads it and has nothing to hear.
 */
function warnOnDrift() {
    const pkg = require("../package.json");
    const spec = pkg.dependencies["uWebSockets.js"];
    const pinnedVersion = /#v?([\d.]+)$/.exec(spec)?.[1];
    // The binaries branch can keep the release's version after rebuilding newer source. Its
    // source_commit file records that source; uwsSourceCommit is copied from the pinned build.
    const pinnedSource = /#[a-f\d]{40}$/i.test(spec) ? pkg.uwsSourceCommit : undefined;
    /** @type {string|undefined} */
    let installed;
    /** @type {string|undefined} */
    let source;
    try {
        // its exports map does not expose package.json, so it is read beside the entry point
        const path = require("path");
        const fs = require("fs");
        const beside = path.dirname(require.resolve("uWebSockets.js"));
        installed = JSON.parse(fs.readFileSync(path.join(beside, "package.json"), "utf8")).version;
        if (pinnedSource) source = fs.readFileSync(path.join(beside, "source_commit"), "utf8").trim();
    } catch {
        // nothing to compare against, which is not worth a warning of its own
    }
    const expected = pinnedSource ?? pinnedVersion;
    const actual = pinnedSource ? source : installed;
    if (expected && actual && actual !== expected) {
        const found = pinnedSource ? `${installed ?? "unknown"} (source ${source})` : installed;
        const tested = pinnedSource ? `source ${pinnedSource}` : pinnedVersion;
        console.warn(
            `fulmine.js: uWebSockets.js ${found} is installed, this version was tested with ${tested}.\n` +
                "  On pnpm the pin is the project's own: `npx fulmine.js pnpm` writes the tested one."
        );
    }
}

/**
 * The µWS module. H3App, DeclarativeResponse and _cfg exist at runtime but are missing from the
 * .d.ts the package ships, so it is handed back loosely typed.
 *
 * @returns {any}
 */
function loadUWS() {
    if (uWS === undefined) {
        if (otherRuntime) {
            throw new Error(
                `fulmine.js: µWebSockets.js does not load on ${otherRuntime}, so WebSockets, TLS through ` +
                    `express({ uwsOptions }) and app.uwsApp need Node. Plain HTTP works, through ${otherRuntime}'s node:http.`
            );
        }
        warnOnDrift();
        uWS = /** @type {any} */ (require("uWebSockets.js"));
        try {
            // disable Uwebsockets header
            uWS._cfg("999999990007");
        } catch (error) {
            // older uWS builds do not expose _cfg; there is nothing to fall back to
        }
    }
    return uWS;
}

module.exports = { loadUWS, otherRuntime };
