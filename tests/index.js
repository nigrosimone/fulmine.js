// npm run test - runs all tests
// npm run test routing - runs all tests in the routing category
// npm run test tests/tests/routing - runs all tests in the routing category
// npm run test tests/tests/listen/listen-random.js - runs the test at tests/tests/listen/listen-random.js
// npm run test -- --jobs 4 - how many files run at once, half the threads by default, 1 is a serial run

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("node:net");
const test = require("node:test");
const childProcess = require("node:child_process");
// execFile and not exec: exec goes through a shell, so the node process is the shell's child and
// the SIGKILL below reaches the shell alone. A timed-out arm then kept its port for the rest of
// the run, and every file after it waited the budget in waitForFreePorts and failed against a
// server that was still answering. Measured on 2026-09-13: the shell died, node did not, and the
// coverage job spent thirty minutes failing every test after the first slow one.
const execFile = require("util").promisify(childProcess.execFile);
const assert = require("node:assert");

const TEST_TIMEOUT = 60000;

// Several files run at once, so no two may share a port. Every port a file names is rewritten to
// one this run hands out, from a range no file names and no ephemeral socket takes, and never
// handed out twice in a run. A file gets a block of consecutive ports and its literals keep their
// distance inside it, since one file counts up from its literal at run time. Both arms of one file
// keep the same ports, since many files print theirs. These are the shapes a port takes in the
// files; a number they match is replaced wherever it appears in that file.
const PORT_SHAPES = [
    /listen\(\s*"?(\d{4,5})/g,
    /\b(?:PORT|port)\s*=\s*(\d{4,5})/g,
    /localhost:(\d{4,5})/g,
    /127\.0\.0\.1:(\d{4,5})/g,
    /connect\(\s*(\d{4,5})/g,
    /port:\s*(\d{4,5})/g,
    // the suite's own family, which one file hands to a function as a bare number
    /\b(1333\d)\b/g
];
const PORT_BLOCK = 8;
const FIRST_PORT = 20000;
// linux hands ephemeral ports out from 32768, windows from 49152
const LAST_PORT = 32767;
let nextPort = FIRST_PORT;

// The second arm of a file binds the ports the first one just released, and two uWS servers can
// hold one at the same time: verified on Windows, where the second listen succeeds and the older
// server keeps answering. An arm that starts while the other is still exiting would then read the
// other arm's answers, which is worse than a red test: it is a green one that compared a server
// with itself.
const PORT_WAIT_STEPS = 200;
const PORT_WAIT_MS = 25;

/** @param {string} code @returns {number[]} the ports this file names */
function portsOf(code) {
    const ports = new Set();
    for (const shape of PORT_SHAPES) {
        for (const match of code.matchAll(shape)) {
            ports.add(Number(match[1]));
        }
    }
    return [...ports];
}

/** @param {number} port @returns {Promise<boolean>} whether anything answers there right now */
function portBusy(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        const done = (busy) => {
            socket.destroy();
            resolve(busy);
        };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        socket.setTimeout(500, () => done(false));
    });
}

/**
 * Hands out a block of ports nothing answers on. The counter moves before the first await, so two
 * files asking at once never get the same block.
 *
 * @returns {Promise<number>} the first port of the block
 */
async function freeBlock() {
    for (;;) {
        if (nextPort + PORT_BLOCK > LAST_PORT) {
            throw new Error(`ran out of ports at ${LAST_PORT}`);
        }
        const base = nextPort;
        nextPort += PORT_BLOCK;
        let busy = false;
        for (let port = base; port < base + PORT_BLOCK && !busy; port++) {
            busy = await portBusy(port);
        }
        if (!busy) {
            return base;
        }
    }
}

/**
 * Waits until nothing is listening on these ports, so an arm cannot reach the arm before it.
 *
 * @param {number[]} ports
 * @returns {Promise<number[]>} the ports still answering when the wait ran out, which is a server
 *   the other arm left behind rather than one still shutting down
 */
async function waitForFreePorts(ports) {
    const stillBusy = [];
    for (const port of ports) {
        let step = 0;
        for (; step < PORT_WAIT_STEPS; step++) {
            if (!(await portBusy(port))) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, PORT_WAIT_MS));
        }
        if (step === PORT_WAIT_STEPS) {
            stillBusy.push(port);
        }
    }
    return stillBusy;
}

// see tests/win-exit-delay.cjs: without it every test crashes on exit under Node 24+ on Windows
const NODE_ARGS = process.platform === "win32" ? ["--require", path.join(__dirname, "win-exit-delay.cjs")] : [];
// what a file asking for it gets, see tests/inspect-preload.cjs
const INSPECT_ARG = ["--require", path.join(__dirname, "inspect-preload.cjs")];
// the reference arm of a --self run, see tests/generic-preload.cjs
const GENERIC_ARG = ["--require", path.join(__dirname, "generic-preload.cjs")];

// --self replaces the Express arm with a second run of this framework, with the optimizer off.
// Every file then answers the question the corpus was not written for: does µWS answering by itself
// give what the ordinary chain gives. A divergence is a bug by construction rather than a
// compatibility question, so nothing about Express bounds what it can catch.
const SELF = process.argv.includes("--self");
const REFERENCE = SELF ? "generic" : "express";

// Half the threads, which is the physical cores on most machines: at one per thread a file that
// compresses a large body hung at 60s twice in a row on the fulmine arm, once in three runs
// (2026-09-21, 8 threads), and at half it did not. --jobs 1 is the old serial run
const jobsFlag = process.argv.indexOf("--jobs");
const JOBS =
    jobsFlag === -1
        ? Math.max(2, Math.floor(os.availableParallelism() / 2))
        : Math.max(1, Number(process.argv[jobsFlag + 1]) || 1);

const EXPRESS_REQUIRE = `const express = require("express");`;
const SOURCE_REQUIRE = `const express = require("../../../src/index.js");`;

// An arm runs a copy of the file, beside it so its relative requires resolve, and not the file
// itself: with several in flight a rewrite in place is what the editor shows and what a commit made
// meanwhile records. The copy is removed when the file is done, and a run that was killed leaves
// them for the next one to sweep.
const RUN_SUFFIX = ".run.cjs";

/**
 * The file as one arm runs it: its import pointed at the framework under test, its ports replaced.
 *
 * @param {string} code
 * @param {string} module express, fulmine or generic
 * @param {[number, number][]} portMap
 * @returns {string}
 */
function armSource(code, module, portMap) {
    let source = module === "express" ? code : code.replace(EXPRESS_REQUIRE, SOURCE_REQUIRE);
    for (const [from, to] of portMap) {
        source = source.replace(new RegExp(`\\b${from}\\b`, "g"), String(to));
    }
    return source;
}

const testPath = path.join(__dirname, "tests");

let testCategories = fs.readdirSync(testPath).sort((a, b) => parseInt(a) - parseInt(b));
const filterPath = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined;

for (const category of testCategories) {
    for (const name of fs.readdirSync(path.join(testPath, category))) {
        if (name.endsWith(RUN_SUFFIX)) {
            fs.rmSync(path.join(testPath, category, name), { force: true });
        }
    }
}

if (filterPath) {
    if (!filterPath.endsWith(".js")) {
        testCategories = testCategories.filter((category) => category.startsWith(path.basename(filterPath)));
    } else {
        // basename, not split(path.sep): on Windows path.sep is a backslash, so a path typed with
        // forward slashes never split and the whole "tests/tests/middlewares" came back as the
        // category name. path.basename handles either separator on both platforms
        testCategories = [path.basename(path.dirname(filterPath))];
    }
}

/**
 * @typedef {object} Job one file, both arms
 * @property {string} category
 * @property {string} name
 * @property {string} path
 * @property {string} runPath the copy the arms run
 * @property {string} code
 * @property {string} description
 * @property {Set<string>} markers
 * @property {number[]} ports the blocks the file was given, for the wait between the arms
 * @property {Promise<{reference: string, fulmine: string}>} done
 * @property {(outputs: {reference: string, fulmine: string}) => void} resolve
 * @property {(error: Error) => void} reject
 */

/** @type {Job[]} */
const jobs = [];

for (const category of testCategories) {
    // some tests write scratch directories next to themselves, and a leftover one
    // would otherwise be read as if it were a test file
    const names = fs
        .readdirSync(path.join(testPath, category))
        .filter((name) => name.endsWith(".js"))
        .sort((a, b) => parseInt(a) - parseInt(b));
    for (const name of names) {
        if (filterPath && filterPath.endsWith(".js") && path.basename(name) !== path.basename(filterPath)) {
            continue;
        }
        const filePath = path.join(testPath, category, name);
        const code = fs.readFileSync(filePath, "utf8").replace(SOURCE_REQUIRE, EXPRESS_REQUIRE);
        if (!code.includes(EXPRESS_REQUIRE)) {
            throw new Error(`${filePath} does not require express`);
        }
        const lines = code.split("\n");

        // The markers live in the comment block at the top, and not always on the second line: a
        // file whose description runs to a paragraph writes them under that instead, and seven of
        // them did while this only ever read line two, so those seven were never inspected. Only
        // the leading block is read, so the word further down in a test cannot switch a file's
        // inspection on by accident.
        const markers = new Set();
        for (const line of lines.slice(1)) {
            const trimmed = line.trim();
            if (trimmed !== "" && !trimmed.startsWith("//")) {
                break;
            }
            const markerMatch = trimmed.match(/^\/\/\s*(OFF|INSPECT|SERIAL)(?::\s*(.*))?$/);
            if (markerMatch) {
                markers.add(markerMatch[1]);
            }
        }

        /** @type {Partial<Job>} */
        const job = {
            category,
            name,
            path: filePath,
            runPath: filePath.replace(/\.js$/, RUN_SUFFIX),
            code,
            description: lines[0].slice(2).trim(),
            markers,
            ports: []
        };
        job.done = new Promise((resolve, reject) => {
            job.resolve = resolve;
            job.reject = reject;
        });
        // the test that reads it is created later; until then a failure must not be an unhandled
        // rejection, which would end the run
        job.done.catch(() => {});
        jobs.push(/** @type {Job} */ (job));
    }
}

// the copies on disk right now, removed on the way out however the run ends
/** @type {Set<string>} */
const running = new Set();

process.on("exit", () => {
    for (const file of running) {
        fs.rmSync(file, { force: true });
    }
});
for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => process.exit(1));
}

/**
 * One arm of a file, from its copy on disk.
 *
 * @param {Job} job
 * @param {string} module express, fulmine or generic
 * @returns {Promise<string>} what it printed
 */
async function execArm(job, module) {
    const stillBusy = await waitForFreePorts(job.ports);
    // The other arm is still answering there, and this one is about to be compared against it.
    // Said out loud rather than waited out in silence: it is one cause with one cure, and a run
    // that hides it reads as a failure for no reason
    if (stillBusy.length) {
        console.error(
            `${stillBusy.join(", ")} still answering after ${(PORT_WAIT_STEPS * PORT_WAIT_MS) / 1000}s, ` +
                `so ${module} runs against whatever holds them: ${job.path}`
        );
    }
    const args = [
        ...NODE_ARGS,
        ...(job.markers.has("INSPECT") ? INSPECT_ARG : []),
        ...(module === "generic" ? GENERIC_ARG : []),
        job.runPath
    ];
    const options = { maxBuffer: 1024 * 1024 * 100, timeout: TEST_TIMEOUT, killSignal: "SIGKILL" };
    // exec kills the child at the limit, so a hung arm rejects here instead of hanging the run.
    // One retry, because a shared CI runner can stall for a minute for reasons that are nobody's
    // code (res-send-file-large, node 24, 2026-08-04); the second timeout is a real hang and
    // fails with the arm's name.
    for (let attempt = 1; ; attempt++) {
        try {
            // the same node that runs this, rather than whichever one a PATH lookup would find
            return (await execFile(process.execPath, args, options)).stdout;
        } catch (error) {
            // maxBuffer also kills the child, and retrying an output that big would only mislabel
            // it as a hang
            const timedOut = error.killed && !String(error.message).includes("maxBuffer");
            // The libuv exit assertion this project already carries a preload for, see
            // tests/win-exit-delay.cjs. The child prints everything it was going to print and then
            // dies on the way out, so the run is sound and only the exit code is not. It is timing
            // dependent, so one retry clears it; twice in a row is something else and fails.
            const crashedOnExit = String(error.stderr || "").includes("UV_HANDLE_CLOSING");
            if (!timedOut && !crashedOnExit) {
                throw error;
            }
            const what = timedOut ? `timed out at ${TEST_TIMEOUT}ms` : "crashed on exit in libuv";
            // what the arm had printed when it stopped is the only thing that says where: a hang
            // after the third request is a different bug from one at listen()
            const sofar = timedOut ? `, printed so far:\n${String(error.stdout || "").trimEnd()}\n` : "";
            if (attempt > 1) {
                throw new Error(`${module} ${what} twice running ${job.path}${sofar}`, { cause: error });
            }
            console.error(`${module} ${what} running ${job.path}, retrying once${sofar}`);
        }
    }
}

/**
 * Both arms of a file, the reference first. Express 5 is the reference: the package named
 * "express" is v5, so the file runs as written. Under --self the reference is this framework with
 * its optimizer off, so the copy points at the source for both arms and only the preload differs.
 *
 * @param {Job} job
 * @returns {Promise<{reference: string, fulmine: string}>}
 */
async function runJob(job) {
    /** @type {[number, number][]} */
    const portMap = [];
    job.ports = [];
    // a literal too far from the block's first one, 13399 beside 13333, opens a block of its own
    let first = -Infinity;
    let base = 0;
    for (const port of portsOf(job.code).sort((a, b) => a - b)) {
        if (port - first >= PORT_BLOCK) {
            first = port;
            base = await freeBlock();
            for (let held = base; held < base + PORT_BLOCK; held++) {
                job.ports.push(held);
            }
        }
        portMap.push([port, base + (port - first)]);
    }
    running.add(job.runPath);
    try {
        fs.writeFileSync(job.runPath, armSource(job.code, REFERENCE, portMap));
        const reference = await execArm(job, REFERENCE);
        fs.writeFileSync(job.runPath, armSource(job.code, "fulmine", portMap));
        const fulmine = await execArm(job, "fulmine");
        return { reference, fulmine };
    } finally {
        fs.rmSync(job.runPath, { force: true });
        running.delete(job.runPath);
    }
}

// what the terminal shows of a disagreement; the rest is in the two files
const DIFF_LINES = 200;

/**
 * The two outputs as a unified diff, from git, which is here wherever this runs. Empty when it is
 * not.
 *
 * @param {string[]} files reference first
 * @returns {string} ending in a newline, or empty
 */
function unifiedDiff(files) {
    const git = childProcess.spawnSync("git", ["diff", "--no-index", "--no-color", "-U3", ...files], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 100
    });
    if (git.error || typeof git.stdout !== "string") {
        return "";
    }
    // git's header names the files, which are printed after the diff anyway; the arms are what a
    // reader needs
    const lines = git.stdout.split("\n").filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line));
    const shown = [`--- ${REFERENCE}`, "+++ fulmine", ...lines.slice(0, DIFF_LINES)];
    if (lines.length > DIFF_LINES) {
        shown.push(`... ${lines.length - DIFF_LINES} more lines in the files`);
    }
    return shown.join("\n").replace(/\n*$/, "\n");
}

/** @param {Job} job */
function settle(job) {
    return runJob(job).then(job.resolve, job.reject);
}

// The work runs ahead of the reporting: JOBS files at a time, in order, each test below waiting
// for its own. A SERIAL file measures time or takes the whole machine, so those go first and one
// at a time, with nothing else running
async function runAll() {
    const queue = jobs.filter((job) => !job.markers.has("OFF"));
    for (const job of queue.filter((job) => job.markers.has("SERIAL"))) {
        await settle(job);
    }
    const parallel = queue.filter((job) => !job.markers.has("SERIAL"));
    const worker = async () => {
        for (let job; (job = parallel.shift());) {
            await settle(job);
        }
    };
    await Promise.all(Array.from({ length: JOBS }, worker));
}
runAll();

// how many files this run will go through, so every line can say where it is
const plannedTotal = jobs.length;
let planned = 0;

for (const testCategory of testCategories) {
    test(testCategory, async () => {
        for (const job of jobs.filter((job) => job.category === testCategory)) {
            await new Promise((resolve) => {
                test(`${job.description} (${++planned}/${plannedTotal})`, async (t) => {
                    try {
                        if (job.markers.has("OFF")) {
                            t.skip();
                            return;
                        }
                        const { reference, fulmine } = await job.done;
                        if (fulmine !== reference) {
                            // kept on disk, because a disagreement that does not happen again is
                            // only diagnosable from what the two arms actually wrote
                            const dir = path.join(__dirname, "..", "test-failures");
                            fs.mkdirSync(dir, { recursive: true });
                            const stem = path.join(dir, `${testCategory}-${job.name.replace(/\.js$/, "")}`);
                            const files = [`${stem}.express.txt`, `${stem}.fulmine.txt`];
                            fs.writeFileSync(files[0], reference);
                            fs.writeFileSync(files[1], fulmine);
                            console.error(
                                `${job.path}: the two arms differ\n${unifiedDiff(files)}wrote ${files.join(" and ")}`
                            );
                            assert.fail(`the two arms differ, the diff is above and the outputs are in ${dir}`);
                        }
                    } finally {
                        resolve();
                    }
                });
            });
        }
    });
}
