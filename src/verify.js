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

// npx fulmine verify
//
// Whether this machine, and the image it will be deployed in, can run the thing at all. Not
// whether the application behaves the same, which is what the test suite and `differences` are
// for: this is the question that comes before it, and it is the one that costs an hour when the
// answer is no and nobody asked.
//
// There is a µWebSockets.js binary underneath, and a binary has requirements a package does not:
// it is built per platform, per architecture and per node ABI, and it is linked against glibc. An
// Alpine image, a node version the pinned build has no binary for, a musl base chosen by a
// Dockerfile written before any of this: each one fails at require time, in a container, in CI,
// with a message about a missing module that says nothing about what to do.
//
// Thirty seconds here instead.

"use strict";

const fs = require("fs");
const path = require("path");

// The oldest glibc the pinned µWS binaries are built against. A runtime older than this loads the
// file and then fails on a symbol, which is a worse error than not finding it at all.
const MIN_GLIBC = "2.38";

// What a project may carry that needs a different API here rather than none. Everything that just
// works, and everything that only wants a faster built-in, is `npx fulmine migrate`'s business.
const NEEDS_A_LOOK = {
    "socket.io": "attach it with io.attachApp(app.uwsApp), not io.attach(server): there is no node socket to take over",
    ws: "the websocket server is µWS's own, through app.ws(path, behavior)",
    "express-ws": "the same: app.ws(path, behavior) is built in",
    spdy: "no spdy here; TLS is configured through express({ uwsOptions: { key_file_name, cert_file_name } })",
    "http2-express-bridge": "no HTTP/2 server to bridge to"
};

/**
 * One line of the report. Three levels, and only one of them is a failure: an image that cannot
 * load the binary stops the deployment, while a dependency that wants a different call is
 * something to read, not something to fail a pipeline over.
 *
 * @param {"ok"|"note"|"no"} level
 * @param {string} what
 * @param {string} [detail] what to do about it
 * @returns {{level: "ok"|"note"|"no", what: string, detail: string|undefined}}
 */
function result(level, what, detail) {
    return { level, what, detail };
}

/**
 * Whether a version string is at least the other, compared piece by piece so "2.38" and "2.9"
 * order the way versions do rather than the way strings do.
 *
 * @param {string} version
 * @param {string} minimum
 * @returns {boolean}
 */
function atLeast(version, minimum) {
    const left = version.split(".").map(Number);
    const right = minimum.split(".").map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const a = left[i] ?? 0;
        const b = right[i] ?? 0;
        if (a !== b) {
            return a > b;
        }
    }
    return true;
}

/**
 * The node this is running on, against what the package asks for.
 *
 * The version arrives as an argument rather than being read here, so the answer for a node this
 * machine is not running is testable from the machine it is not running on. Every check below
 * takes what it judges for the same reason.
 *
 * @param {string} [running] defaults to the node running this
 * @param {string} [required] defaults to what package.json asks for
 * @returns {ReturnType<typeof result>}
 */
function checkNode(running = process.versions.node, required = require("../package.json").engines.node) {
    const minimum = required.replace(/[^0-9.]/g, "");
    if (atLeast(running, minimum)) {
        return result("ok", `Node ${running}`);
    }
    return result("no", `Node ${running}`, `this package needs ${required}. Upgrade node, or pin an older fulmine.`);
}

/**
 * The glibc this process is running against, or undefined when there is none to report, which is
 * what a musl build looks like from in here.
 *
 * @returns {string|undefined}
 */
function currentGlibc() {
    return /** @type {any} */ (process.report.getReport()).header.glibcVersionRuntime;
}

/**
 * Whether the C library is the one the binaries are linked against. Only linux has two of them.
 *
 * Both arguments are required, and deliberately: undefined is the answer that means musl, and a
 * default parameter fires on an explicit undefined, so a default here would quietly turn the musl
 * case into whatever this machine happens to run. Reading the machine is the caller's job.
 *
 * @param {string} platform
 * @param {string|undefined} glibc the runtime glibc, absent on musl
 * @returns {ReturnType<typeof result>|undefined} undefined where the question does not arise
 */
function checkLibc(platform, glibc) {
    if (platform !== "linux") {
        return undefined;
    }
    if (!glibc) {
        return result(
            "no",
            "musl libc, which the µWebSockets.js binaries are not built for",
            "this is Alpine, or another musl distribution. Use a glibc image: node:22-trixie-slim, " +
                "node:24-bookworm-slim\n    or the plain node:22. There is no musl build to install."
        );
    }
    if (!atLeast(glibc, MIN_GLIBC)) {
        return result(
            "no",
            `glibc ${glibc}`,
            `the binaries need ${MIN_GLIBC} or newer. A newer base image is the fix: node:22-trixie-slim.`
        );
    }
    return result("ok", `glibc ${glibc}`);
}

/**
 * Whether there is a µWebSockets.js binary for this platform, architecture and node ABI, which is
 * the failure that greets everyone who tries an unusual combination. The file is named rather than
 * loaded first, so the answer says which of the three does not line up.
 *
 * @param {string} [platform]
 * @param {string} [arch]
 * @param {string} [abi]
 * @param {string} [from] the directory holding the binaries, for a test that has no real one
 * @returns {ReturnType<typeof result>}
 */
function checkBinary(platform = process.platform, arch = process.arch, abi = process.versions.modules, from) {
    const name = `uws_${platform}_${arch}_${abi}.node`;
    let dir = from;
    if (dir === undefined) {
        try {
            dir = path.dirname(require.resolve("uWebSockets.js"));
        } catch {
            return result("no", "uWebSockets.js is not installed", "run npm install.");
        }
    }
    if (fs.existsSync(path.join(dir, name))) {
        // named and present, so the only thing left is whether it loads
        try {
            require("uWebSockets.js");
            return result("ok", `µWebSockets.js binary for ${platform} ${arch}, node ABI ${abi}`);
        } catch (err) {
            return result(
                "no",
                `${name} is there and will not load`,
                `${/** @type {Error} */ (err).message}\n    On linux this is nearly always the C library, see the line above.`
            );
        }
    }
    const prefix = `uws_${platform}_${arch}_`;
    const shipped = fs
        .readdirSync(dir)
        .filter((file) => file.startsWith(prefix) && file.endsWith(".node"))
        .map((file) => file.slice(prefix.length, -".node".length));
    if (shipped.length === 0) {
        return result(
            "no",
            `no µWebSockets.js binary for ${platform} ${arch}`,
            "this platform is not one the pinned build ships. Linux, macOS and Windows on x64 or arm64 are."
        );
    }
    return result(
        "no",
        `no µWebSockets.js binary for node ABI ${abi}`,
        `this build ships ABI ${shipped.join(", ")}, which is node ${shipped.map(abiToNode).join(", ")}.\n` +
            `    Run one of those, or wait for a fulmine that pins a newer µWebSockets.js.`
    );
}

/**
 * The node release line an ABI number belongs to, for the versions this package can meet. An
 * unknown one is reported as itself rather than guessed at.
 *
 * @param {string} abi
 * @returns {string}
 */
function abiToNode(abi) {
    const known = { 108: "18", 115: "20", 127: "22", 131: "23", 137: "24", 147: "26" };
    return /** @type {any} */ (known)[abi] ?? `ABI ${abi}`;
}

/**
 * The base images a Dockerfile names, which is where the musl question is usually answered without
 * anybody meaning to.
 *
 * @param {string} dir the project being verified
 * @returns {ReturnType<typeof result>[]}
 */
function checkDockerfiles(dir) {
    /** @type {ReturnType<typeof result>[]} */
    const results = [];
    let names;
    try {
        names = fs.readdirSync(dir).filter((file) => file === "Dockerfile" || file.startsWith("Dockerfile."));
    } catch {
        return results;
    }
    for (const name of names) {
        const source = fs.readFileSync(path.join(dir, name), "utf8");
        for (const line of source.split("\n")) {
            const match = /^\s*FROM\s+(\S+)/i.exec(line);
            if (!match) {
                continue;
            }
            const image = match[1];
            const where = `${name}: ${image}`;
            if (/alpine|musl/i.test(image)) {
                results.push(
                    result("no", where, "musl, and there is no musl build: node:22-trixie-slim is the closest swap.")
                );
                continue;
            }
            const node = /^node:(\d+)/.exec(image);
            if (node && Number(node[1]) < 22) {
                results.push(result("no", where, `this package needs node 22 or newer: node:22-trixie-slim.`));
                continue;
            }
            results.push(result("ok", where));
        }
    }
    return results;
}

/**
 * The dependencies that need a different API here. Read from package.json rather than from
 * node_modules, so a project is answered before it installs anything.
 *
 * @param {string} dir
 * @returns {ReturnType<typeof result>[]}
 */
function checkDependencies(dir) {
    /** @type {ReturnType<typeof result>[]} */
    const results = [];
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
        return results;
    }
    const installed = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of Object.keys(NEEDS_A_LOOK)) {
        if (installed[name]) {
            results.push(result("note", `${name} needs a different API here`, /** @type {any} */ (NEEDS_A_LOOK)[name]));
        }
    }
    return results;
}

/**
 * Runs every check and prints the report. Anything that would stop the application from starting
 * is a failure and the command exits non-zero, so it can be a step in a pipeline.
 *
 * @param {string[]} argv
 * @returns {number} exit code
 */
function verify(argv) {
    const dir = path.resolve(argv.find((arg) => !arg.startsWith("--")) ?? ".");
    /** @type {ReturnType<typeof result>[]} */
    const results = [checkNode()];
    const libc = checkLibc(process.platform, currentGlibc());
    if (libc) {
        results.push(libc);
    }
    results.push(checkBinary(), ...checkDockerfiles(dir), ...checkDependencies(dir));

    console.log(`\nWhether this machine and this project can run fulmine.js\n`);
    const label = { ok: "ok  ", note: "note", no: "NO  " };
    for (const { level, what, detail } of results) {
        console.log(`  ${label[level]}  ${what}`);
        if (level !== "ok" && detail) {
            console.log(`        ${detail}`);
        }
    }
    // only a blocked start is a failure. A dependency that wants a different call is worth
    // reading and is not worth failing a pipeline over
    const blocking = results.filter((entry) => entry.level === "no").length;
    const notes = results.filter((entry) => entry.level === "note").length;
    console.log(
        blocking === 0
            ? `\nNothing in the way${notes ? `, ${notes} thing(s) worth reading` : ""}.\n`
            : `\n${blocking} thing(s) stop this from running.\n`
    );
    return blocking === 0 ? 0 : 1;
}

module.exports = { verify, checkNode, checkLibc, currentGlibc, checkBinary, checkDockerfiles, checkDependencies };
