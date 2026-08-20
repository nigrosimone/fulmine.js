"use strict";

// Where the time goes, by function, and how that changes between two revisions.
//
//   node benchmark/profile.js --scenario api-endpoint
//   node benchmark/profile.js --scenario api-endpoint --against HEAD
//   node benchmark/profile.js --scenario routes-1000 --against main --rounds 5
//
// This exists because ab.js cannot see a small change. A laptop's null control spreads by about ten
// percent, so anything worth a few percent is inside it and comes back as noise however many rounds
// are run. A profile is a different instrument: it counts where the samples land rather than how
// many requests finished, so work that stops happening shows up as a share falling even when the
// request counter cannot tell.
//
// Use ab.js for a change big enough to move throughput, and this for one that should remove work.
// The ETag change of 2026-08-02 read 0.9871 through ab.js, which is nothing, and showed here as the
// hashing path going from 7.24% of samples to 5.81% with the garbage collector halving alongside.
//
// Two things this had to learn the hard way, both of which made it lie before they were fixed:
//
// Idle is excluded from the total. A change that removes work leaves the server idle for longer,
// and against a total that counted idle every untouched function's share fell with it, so the table
// read as though everything had got faster at once.
//
// Rounds, and the median of them per function, because one run per arm cannot resolve half a point.
// Measured while writing this: between two runs of the same code, functions nobody had touched
// moved by 0.5 to 0.8 points. Anything smaller than the spread this reports is not a result.
//
// The servers stay up across rounds and the profiler is cut at the end of each one, so a round is
// measured on a warm server rather than on one still being compiled.
//
// Since 2026-08-15 every sample is weighted by the profile's own timeDelta instead of a flat
// 100us, see issue #8: the profiler is asked for 100us and delivers about 1600Hz on this machine,
// a median delta of 600us, so the flat billing read about 6x too low. Numbers printed before that
// date are not comparable with new runs. The idle share is printed too rather than dropped
// silently, because uWS's own C++ is what V8 tags as idle: a change that moves work into or out
// of uWS shows up there and nowhere else.
//
// The settings are benchmark/server.js's, which turns off ETags, x-powered-by and the declarative
// compiler so that what is measured is the framework doing the work rather than uWS answering from
// a response written at startup. An application running the defaults pays for the ETag as well.

const fs = require("fs");
const path = require("path");
const os = require("os");
const autocannon = require("autocannon");
const {
    startScenarioServer,
    waitForReady,
    stopScenarioServer,
    addWorktree,
    removeWorktree,
    assertScenarioAnswers
} = require("./harness.js");

const BASELINE = { id: "fulmine", label: "baseline", port: 3120 };
const CANDIDATE = { id: "fulmine", label: "candidate", port: 3121 };
// frames costing less than this are left out: a profile has a long tail of one-sample frames and
// printing it hides the handful of lines worth reading. In microseconds per thousand requests.
// 120 where it was 20: the reweighting multiplied every number by about six, and this keeps the
// same frames in the table
const MIN_COST = 120;
// Idle is not work. Counting it would make every other number depend on how hard the load generator
// managed to push, which is not what any of this is about.
const IDLE_FRAME = "(idle)";

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const value = argv[i];
        if (!value.startsWith("--")) {
            continue;
        }
        const key = value.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
            args[key] = true;
        } else {
            args[key] = next;
            i++;
        }
    }
    return args;
}

function resolveRequest(scenario) {
    const request = scenario.request || {};
    let body = request.body ?? null;
    if (request.bodyRepeat && typeof request.bodyRepeat === "object") {
        body = String(request.bodyRepeat.char || "a").repeat(Number(request.bodyRepeat.count || 0));
    }
    return {
        method: request.method || "GET",
        path: request.path || scenario.path,
        headers: { ...(request.headers || {}) },
        body
    };
}

function median(values) {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Self time by function, in microseconds of CPU per thousand requests served, each sample billed
 * at its own timeDelta rather than at the interval the profiler was asked for, which it does not
 * honour, see the header.
 *
 * Not a share of the profile, which is what this reported first and had to stop reporting: shares
 * add up to a hundred, so one function falling pushes every other one up and the table fills with
 * moves that nobody made. A run where the only real change was in the Request constructor showed
 * JSON.stringify dropping 1.28 points beside it, for no reason other than arithmetic.
 *
 * Per request is the question anyway. A framework is not trying to own a smaller share of its own
 * profile, it is trying to spend less on each request it serves.
 *
 * Self time and not total, because a function high in the stack would otherwise be credited with
 * everything it called.
 *
 * @param {any} profile
 * @param {number} requests how many requests the load generator counted during this profile
 * @returns {{costs: Map<string, number>, idleShare: number}} costs per function, and the share of
 *   the profile's time spent idle, where V8 books uWS's own C++
 */
function costPerThousandRequests(profile, requests) {
    // node id -> printable frame, null for the idle node
    const frames = new Map();
    for (const node of profile.nodes) {
        const frame = node.callFrame;
        if (frame.functionName === IDLE_FRAME) {
            frames.set(node.id, null);
            continue;
        }
        const url = (frame.url || "").replace(/^file:\/\/\//, "");
        // a node_modules path is only worth the package name, and everything else its last two
        // segments: the machine's directory layout is not information
        const where = url.includes("node_modules")
            ? "node_modules/" + url.split("node_modules/").pop().split(/[\\/]/)[0]
            : url.split(/[\\/]/).slice(-2).join("/");
        frames.set(node.id, `${frame.functionName || "(anonymous)"} @ ${where || "(native)"}`);
    }

    const totals = new Map();
    const samples = profile.samples;
    const deltas = profile.timeDeltas;
    let idleTime = 0;
    let wallTime = 0;
    for (let i = 1; i < samples.length; i++) {
        const delta = deltas[i];
        // the clock is not monotonic sample to sample, v8 emits the odd negative delta
        if (!(delta > 0)) {
            continue;
        }
        const key = frames.get(samples[i]);
        if (key === undefined) {
            // a sample of a node the profile did not describe, seen in truncated profiles
            continue;
        }
        wallTime += delta;
        if (key === null) {
            idleTime += delta;
            continue;
        }
        totals.set(key, (totals.get(key) || 0) + delta);
    }

    const out = new Map();
    for (const [key, time] of totals) {
        out.set(key, (time * 1000) / requests);
    }
    return { costs: out, idleShare: wallTime > 0 ? idleTime / wallTime : 0 };
}

class Arm {
    /**
     * One server under the profiler, kept alive so that every round is measured warm.
     *
     * @param {{id: string, label: string, port: number}} framework
     * @param {string|null} src FULMINE_SRC for a revision checked out beside the working tree
     */
    constructor(framework, src) {
        this.framework = framework;
        this.src = src;
        this.handle = null;
        this.rounds = [];
        this.requestsPerSecond = [];
        // one entry per recorded round: how much of that round's profile was idle
        this.idleShares = [];
    }

    async start(scenarioName) {
        const env = {
            NODE_ENV: "production",
            PROFILE_OUT: path.join(os.tmpdir(), `fulmine-${this.framework.label}-${process.pid}.cpuprofile`),
            ...(this.src ? { FULMINE_SRC: this.src } : {})
        };
        this.handle = startScenarioServer(this.framework, scenarioName, env, ["ignore", "pipe", "pipe", "ipc"]);
        await waitForReady(this.handle.server, this.framework, scenarioName);
    }

    async load(request, durationSeconds, connections, pipelining) {
        const result = await autocannon({
            url: `http://127.0.0.1:${this.framework.port}${request.path}`,
            method: request.method,
            headers: request.headers,
            body: request.body ?? undefined,
            connections,
            pipelining,
            duration: durationSeconds,
            timeout: 30
        });
        if (result.non2xx > 0 || !result.requests.average) {
            throw new Error(
                `${this.framework.label} answered ${result.non2xx} non-2xx out of ${result.requests.total}, ` +
                    `so this profile is of something other than the scenario`
            );
        }
        this.lastRequests = result.requests.total;
        return Math.round(result.requests.average);
    }

    /** Stops the profile, reads it, and starts the next one on the same warm process. */
    cut(record) {
        const out = path.join(
            os.tmpdir(),
            `fulmine-${this.framework.label}-${process.pid}-${this.rounds.length}.cpuprofile`
        );
        return new Promise((resolve, reject) => {
            const server = /** @type {any} */ (this.handle).server;
            const onMessage = () => {
                server.off("message", onMessage);
                try {
                    const profile = JSON.parse(fs.readFileSync(out, "utf8"));
                    fs.rmSync(out, { force: true });
                    if (record) {
                        const { costs, idleShare } = costPerThousandRequests(profile, this.lastRequests);
                        this.rounds.push(costs);
                        this.idleShares.push(idleShare);
                    }
                    resolve();
                } catch (error) {
                    reject(error);
                }
            };
            server.on("message", onMessage);
            server.send({ cmd: "cut", out });
        });
    }

    async stop() {
        if (!this.handle) {
            return;
        }
        this.handle.server.send({ cmd: "exit" });
        await stopScenarioServer(this.handle.server, this.handle.stderrRef);
    }

    /** The median cost of each function across the rounds, and its spread. */
    summary() {
        const keys = new Set();
        for (const round of this.rounds) {
            for (const key of round.keys()) {
                keys.add(key);
            }
        }
        const out = new Map();
        for (const key of keys) {
            const values = this.rounds.map((round) => round.get(key) || 0);
            out.set(key, { median: median(values), low: Math.min(...values), high: Math.max(...values) });
        }
        return out;
    }
}

function printSingle(arm) {
    const summary = arm.summary();
    const rows = [...summary]
        .filter(([, s]) => s.median >= MIN_COST)
        .sort((a, b) => b[1].median - a[1].median)
        .slice(0, 30);

    const total = [...summary.values()].reduce((sum, s) => sum + s.median, 0);
    process.stdout.write(
        `\n${median(arm.requestsPerSecond)} req/s, ${(total / 1000).toFixed(1)} us of CPU per request, ` +
            `median of ${arm.rounds.length} rounds\n` +
            `${(median(arm.idleShares) * 100).toFixed(0)}% of the profile is idle, which is where uWS's own C++ is booked\n\n` +
            `microseconds per thousand requests, self time, idle excluded\n\n`
    );
    for (const [key, s] of rows) {
        process.stdout.write(
            `${s.median.toFixed(0).padStart(6)}  (${s.low.toFixed(0)}..${s.high.toFixed(0)})  ${key}\n`
        );
    }
}

function printComparison(baseline, candidate) {
    const before = baseline.summary();
    const after = candidate.summary();
    const rows = [];

    for (const key of new Set([...before.keys(), ...after.keys()])) {
        const b = before.get(key)?.median || 0;
        const c = after.get(key)?.median || 0;
        if (b < MIN_COST && c < MIN_COST) {
            continue;
        }
        // How far this function moved between rounds of the same code. A difference smaller than
        // its own spread is not a difference, and printing the spread next to it is what stops the
        // table being read as though every line meant something.
        const wobble = Math.max(
            (before.get(key)?.high || 0) - (before.get(key)?.low || 0),
            (after.get(key)?.high || 0) - (after.get(key)?.low || 0)
        );
        rows.push({ key, b, c, delta: c - b, wobble });
    }
    rows.sort((x, y) => x.delta - y.delta);

    const line = (r) =>
        `${r.b.toFixed(0).padStart(6)} -> ${r.c.toFixed(0).padStart(6)}  ` +
        `${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(0).padStart(5)}  ` +
        `${Math.abs(r.delta) > r.wobble ? "  " : "~ "}${r.key}\n`;

    const totalOf = (summary) => [...summary.values()].reduce((sum, s) => sum + s.median, 0);
    const beforeTotal = totalOf(before);
    const afterTotal = totalOf(after);

    process.stdout.write(
        `\nbaseline ${median(baseline.requestsPerSecond)} req/s, candidate ${median(candidate.requestsPerSecond)} req/s\n` +
            `CPU per request: ${(beforeTotal / 1000).toFixed(1)} us -> ${(afterTotal / 1000).toFixed(1)} us ` +
            `(${(((afterTotal - beforeTotal) / beforeTotal) * 100).toFixed(1)}%)\n` +
            `idle share: ${(median(baseline.idleShares) * 100).toFixed(0)}% -> ${(median(candidate.idleShares) * 100).toFixed(0)}%, ` +
            `which is where uWS's own C++ is booked\n` +
            `microseconds per thousand requests, median of ${baseline.rounds.length} rounds\n` +
            `a ~ marks a move smaller than that function's own spread between rounds, which is to say not a move\n`
    );
    process.stdout.write("\nwhere the time stopped going\n\n");
    for (const r of rows.slice(0, 12)) {
        process.stdout.write(line(r));
    }
    process.stdout.write("\nand where it went instead\n\n");
    for (const r of rows.slice(-8)) {
        process.stdout.write(line(r));
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const scenarioName = args.scenario || "api-endpoint";
    const durationSeconds = Number(args.duration || 10);
    const connections = Number(args.connections || 50);
    const rounds = Number(args.rounds || 3);
    const against = args.against;

    const scenario = require(path.join(__dirname, "scenarios", `${scenarioName}.js`));
    // A scenario that cannot be pipelined says so, and is measured one request per connection
    // rather than reported as broken. The command line still wins over both.
    const pipelining = Number(args.pipelining || (scenario.load && scenario.load.pipelining) || 10);
    const request = resolveRequest(scenario);

    let baselineSrc = null;
    if (against) {
        process.stdout.write(`Checking out ${against} beside the working tree\n`);
        baselineSrc = addWorktree(against);
    }

    const arms = against ? [new Arm(BASELINE, baselineSrc), new Arm(CANDIDATE, null)] : [new Arm(CANDIDATE, null)];
    process.stdout.write(
        `${scenario.name}: ${against ? `${against} against the working tree` : "the working tree"}, ` +
            `${rounds} rounds of ${durationSeconds}s\n`
    );

    try {
        for (const arm of arms) {
            await arm.start(scenarioName);
            // one request that must answer the scenario before any load does: a stray server
            // sharing the port answers something else, and the whole profile would be of it
            await assertScenarioAnswers(arm.framework, request);
        }

        // A round nobody records. Whichever server is hit first is hit cold, and the difference is
        // not small: the first round of a fresh process is still being compiled while it serves.
        process.stdout.write("warmup (not recorded)\n");
        for (const arm of arms) {
            await arm.load(request, Math.min(durationSeconds, 5), connections, pipelining);
            await arm.cut(false);
        }

        for (let round = 0; round < rounds; round++) {
            process.stdout.write(`round ${round + 1}/${rounds}\n`);
            // alternate who goes first, so a machine warming or throttling through the run does not
            // always land on the same arm
            const order = round % 2 === 0 ? arms : [...arms].reverse();
            for (const arm of order) {
                arm.requestsPerSecond.push(await arm.load(request, durationSeconds, connections, pipelining));
                await arm.cut(true);
            }
        }

        if (against) {
            printComparison(arms[0], arms[1]);
        } else {
            printSingle(arms[0]);
        }
    } finally {
        for (const arm of arms) {
            await arm.stop();
        }
        removeWorktree();
    }
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    removeWorktree();
    process.exit(1);
});
