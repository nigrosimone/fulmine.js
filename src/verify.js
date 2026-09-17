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

// npx fulmine verify: whether this machine and the image it deploys in can run it at all. The uWS
// binary is per platform, architecture and node ABI, glibc only, and an Alpine image or a node
// without a binary fails at require time with "missing module". Thirty seconds here instead.

"use strict";

const fs = require("fs");
const path = require("path");
const { detectManager, UWS_SPEC, UWS_OVERRIDE } = require("./adopt.js");

// The oldest glibc the pinned uWS binaries are built against. A runtime older than this loads the
// file and then fails on a symbol, which is a worse error than not finding it at all.
const MIN_GLIBC = "2.38";

// The oldest node this package runs on, and the image to name when something older is found. Both
// follow engines rather than being written out here, so raising it moves every message with it.
const MIN_NODE = require("../package.json").engines.node.replace(/[^0-9.]/g, "");
const MIN_NODE_MAJOR = MIN_NODE.split(".")[0];
const SWAP_IMAGE = `node:${MIN_NODE_MAJOR}-trixie-slim`;

// What a project may carry that needs a different API here. Everything that just works is
// `npx fulmine migrate`'s business.
const NEEDS_A_LOOK = {
    "socket.io": "attach it with io.attachApp(app.uwsApp), not io.attach(server): there is no node socket to take over",
    ws: "the websocket server is µWS's own, through app.ws(path, behavior)",
    "express-ws": "the same: app.ws(path, behavior) is built in",
    spdy: "no spdy here; TLS is configured through express({ uwsOptions: { key_file_name, cert_file_name } })",
    "http2-express-bridge": "no HTTP/2 server to bridge to"
};

/**
 * One line of the report; only "no" is a failure.
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
 * Whether a version is at least the other, piece by piece: "2.38" is after "2.9".
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
 * The node this runs on against what the package asks; an argument, so a test can pass another.
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
 * The glibc this process runs against, undefined on musl.
 *
 * @returns {string|undefined}
 */
function currentGlibc() {
    return /** @type {{header: {glibcVersionRuntime?: string}}} */ (process.report.getReport()).header
        .glibcVersionRuntime;
}

/**
 * Whether the C library is the one the binaries are linked against, on linux. No default for
 * glibc: undefined means musl, and a default would fire on it.
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
            `the binaries need ${MIN_GLIBC} or newer. A newer base image is the fix: ${SWAP_IMAGE}.`
        );
    }
    return result("ok", `glibc ${glibc}`);
}

/**
 * Whether there is a uWebSockets.js binary for this platform, architecture and node ABI. The file
 * is named rather than loaded, so the answer says which of the three does not line up.
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
 * The node release an ABI number belongs to, or the number itself.
 *
 * @param {string} abi
 * @returns {string}
 */
function abiToNode(abi) {
    const known = { 108: "18", 115: "20", 127: "22", 131: "23", 137: "24", 147: "26" };
    return known[abi] ?? `ABI ${abi}`;
}

/**
 * The base images the Dockerfiles name.
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
                    result("no", where, `musl, and there is no musl build: ${SWAP_IMAGE} is the closest swap.`)
                );
                continue;
            }
            const node = /^node:(\d+)/.exec(image);
            if (node && Number(node[1]) < Number(MIN_NODE_MAJOR)) {
                results.push(result("no", where, `this package needs node ${MIN_NODE_MAJOR} or newer: ${SWAP_IMAGE}.`));
                continue;
            }
            results.push(result("ok", where));
        }
    }
    return results;
}

/**
 * The project's package.json, or undefined.
 *
 * @param {string} dir
 * @returns {any}
 */
function readPackage(dir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
        return undefined;
    }
}

/**
 * The dependencies that need a different API here, from package.json so nothing need be installed.
 *
 * @param {string} dir
 * @returns {ReturnType<typeof result>[]}
 */
function checkDependencies(dir) {
    /** @type {ReturnType<typeof result>[]} */
    const results = [];
    const pkg = readPackage(dir);
    if (!pkg) return results;
    const installed = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of Object.keys(NEEDS_A_LOOK)) {
        if (installed[name]) {
            results.push(result("note", `${name} needs a different API here`, NEEDS_A_LOOK[name]));
        }
    }
    return results;
}

// pnpm refuses a git dependency of a dependency since this version, and µWebSockets.js is one
const PNPM_BLOCKS_GIT_SUBDEPS = [10, 26];

/**
 * Whether pnpm will install this at all: 10.26 and later refuse a git dependency of a dependency
 * unless the project has the two lines `npx fulmine.js pnpm` writes, read from pnpm-workspace.yaml
 * as pnpm 11 reads them.
 *
 * @param {string} dir
 * @param {any} pkg the parsed package.json
 * @returns {ReturnType<typeof result>|undefined} nothing to say for npm and yarn
 */
function checkPackageManager(dir, pkg) {
    const { manager, why } = detectManager(dir, pkg);
    if (manager !== "pnpm") return undefined;

    const declared = /^pnpm@(\d+)\.(\d+)/.exec(pkg.packageManager ?? "");
    if (declared) {
        const [major, minor] = [Number(declared[1]), Number(declared[2])];
        const [blockMajor, blockMinor] = PNPM_BLOCKS_GIT_SUBDEPS;
        if (major < blockMajor || (major === blockMajor && minor < blockMinor)) {
            return result("ok", `pnpm ${declared[1]}.${declared[2]} installs a git dependency of a dependency`);
        }
    }

    let workspace = "";
    try {
        workspace = fs.readFileSync(path.join(dir, "pnpm-workspace.yaml"), "utf8");
    } catch {
        // no workspace file, so every setting is at its default
    }

    // the recipe: the project owns the git dependency, and the copy this package asks for is dropped.
    // Only the dots need escaping today, every metacharacter is, so the name stays a literal
    const literal = UWS_OVERRIDE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const dropped = new RegExp(`^\\s*["']?${literal}["']?:\\s*["']?-["']?\\s*$`, "m").test(workspace);
    const own = pkg.dependencies?.["uWebSockets.js"];
    if (dropped && typeof own === "string") {
        if (own === UWS_SPEC) {
            return result(
                "ok",
                "pnpm, with µWebSockets.js as the project's own dependency at the pin this package uses"
            );
        }
        return result(
            "note",
            `pnpm, with µWebSockets.js as the project's own dependency at ${own}`,
            `this package pins ${UWS_SPEC} and was tested against it. \`npx fulmine.js pnpm\` writes the pin.`
        );
    }
    if (dropped) {
        return result(
            "no",
            "pnpm-workspace.yaml drops µWebSockets.js from this package, and the project does not declare it",
            `nothing would install it. \`npx fulmine.js pnpm\` adds "uWebSockets.js": "${UWS_SPEC}" to dependencies.`
        );
    }

    if (/^\s*blockExoticSubdeps:\s*false\s*$/m.test(workspace)) {
        return result("ok", "pnpm, with blockExoticSubdeps off in pnpm-workspace.yaml");
    }
    const registry = /^\s*["']?uWebSockets\.js["']?:\s*["']?([~^]?\d[^"'\s]*)/m.exec(workspace);
    if (registry) {
        return result("ok", `pnpm, with µWebSockets.js overridden to ${registry[1]} from a registry`);
    }

    return result(
        "no",
        `pnpm (${why}) will refuse to install this`,
        "pnpm 10.26 and later block a git dependency of a dependency, and µWebSockets.js is one:\n" +
            "        pnpm add fulmine.js fails with ERR_PNPM_EXOTIC_SUBDEP. `npx fulmine.js pnpm` writes the two\n" +
            "        lines that let it through, see docs/deployment.md."
    );
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
    const manager = checkPackageManager(dir, readPackage(dir) ?? {});
    if (manager) {
        results.push(manager);
    }

    console.log(`\nWhether this machine and this project can run fulmine.js\n`);
    const label = { ok: "ok  ", note: "note", no: "NO  " };
    for (const { level, what, detail } of results) {
        console.log(`  ${label[level]}  ${what}`);
        if (level !== "ok" && detail) {
            console.log(`        ${detail}`);
        }
    }
    // only a blocked start is a failure, a dependency that wants a different call is not
    const blocking = results.filter((entry) => entry.level === "no").length;
    const notes = results.filter((entry) => entry.level === "note").length;
    console.log(
        blocking === 0
            ? `\nNothing in the way${notes ? `, ${notes} thing(s) worth reading` : ""}.\n`
            : `\n${blocking} thing(s) stop this from running.\n`
    );
    return blocking === 0 ? 0 : 1;
}

module.exports = {
    verify,
    checkNode,
    checkLibc,
    currentGlibc,
    checkBinary,
    checkDockerfiles,
    checkDependencies,
    checkPackageManager
};
