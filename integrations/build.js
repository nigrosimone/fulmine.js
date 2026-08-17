// Builds the applications under apps/, which four of the cases need before they can serve anything.
//
// Nest, Apollo and tRPC are libraries: a case requires them and runs. Astro, SvelteKit, React Router
// and Next are frameworks that compile an application first, and what mounts on Express is the
// thing their build produces. So those four keep a small application in apps/ and this builds it.
//
// A build is skipped when its output is already there and newer than every source that went into
// it, which is what makes running one case twice cost nothing. `node build.js --force` rebuilds
// anyway, and `node build.js astro` builds one.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const APPS = path.join(__dirname, "apps");

/** What each application is built with, and the file that says it has been. */
const BUILDS = {
    astro: { output: "dist/server/entry.mjs", command: "astro build" },
    next: { output: ".next/BUILD_ID", command: "next build" },
    "react-router": { output: "build/server/index.js", command: "react-router build" },
    sveltekit: { output: "build/handler.js", command: "vite build" }
};

/** Directories a build writes into, which are not sources however new they are. */
const OUTPUT_DIRS = new Set(["build", "dist", ".next", ".svelte-kit", ".astro", "node_modules"]);

/**
 * The newest mtime among the application's sources.
 *
 * @param {string} dir
 * @returns {number} milliseconds, or 0 for a directory that is not there
 */
function newestSource(dir) {
    let newest = 0;
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
            if (entry.isDirectory()) {
                if (!OUTPUT_DIRS.has(entry.name)) stack.push(path.join(current, entry.name));
                continue;
            }
            const { mtimeMs } = fs.statSync(path.join(current, entry.name));
            if (mtimeMs > newest) newest = mtimeMs;
        }
    }
    return newest;
}

/**
 * Builds one application unless its output is already newer than its sources.
 *
 * @param {string} name a key of BUILDS
 * @param {boolean} [force] build even when it looks up to date
 * @returns {void}
 */
function ensureBuilt(name, force) {
    const build = BUILDS[name];
    if (!build) return; // a case with no application of its own, which is most of them
    const dir = path.join(APPS, name);
    const output = path.join(dir, build.output);

    if (!force && fs.existsSync(output) && fs.statSync(output).mtimeMs >= newestSource(dir)) {
        return;
    }

    console.log(`building ${name}`);
    // shell: true so the name resolves through node_modules/.bin, where npm writes a .cmd wrapper
    // on Windows and a shell script everywhere else
    const result = spawnSync(build.command, {
        cwd: dir,
        shell: true,
        stdio: "inherit",
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PATH: binPath() }
    });
    if (result.status !== 0) {
        throw new Error(`${name}: \`${build.command}\` exited ${result.status}`);
    }
}

/** PATH with this directory's node_modules/.bin in front of it. */
function binPath() {
    const bin = path.join(__dirname, "node_modules", ".bin");
    const current = process.env.PATH ?? process.env.Path ?? "";
    return `${bin}${path.delimiter}${current}`;
}

module.exports = { ensureBuilt, BUILDS };

if (require.main === module) {
    const force = process.argv.includes("--force");
    const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
    for (const name of wanted.length ? wanted : Object.keys(BUILDS)) {
        ensureBuilt(name, force);
    }
}
