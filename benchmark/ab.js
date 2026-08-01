"use strict";

// Measures this working tree against another revision of it.
//
// The two arms run at the same time and the load alternates between them round by round, rather
// than measuring one and then the other. That is not fussiness: run `--null`, which puts the same
// code on both sides, and the per-round ratios still spread by about ten percent on a laptop that
// warms up. Anything measured as "A then B" attributes that drift to the code.
//
//   node benchmark/ab.js --against main
//   node benchmark/ab.js --against main --scenario routes-1000 --rounds 9
//   node benchmark/ab.js --null                 # same code both sides, to see the noise floor
//   node benchmark/ab.js --against main --pipelining 1   # one request per connection at a time
//
// The figure to read is the median of the per-round ratios. If it sits inside the spread that
// --null produces on the same machine, the change did not move anything this can see.
//
// Requests are pipelined by default, which is not the shape of ordinary traffic but is the only
// way this measures the server. autocannon is a single JS thread and runs out before either arm
// does, so with one request in flight per connection both arms report the load generator's ceiling
// and every ratio comes back 1.00 whatever the change was worth.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const autocannon = require("autocannon");
const { startScenarioServer, waitForReady, stopScenarioServer } = require("./harness.js");

const REPO_ROOT = path.join(__dirname, "..");
// inside the repo on purpose: a worktree in the system temp directory cannot resolve node_modules
const WORKTREE_DIR = path.join(REPO_ROOT, ".ab-worktree");

const BASELINE = { id: "fulmine", label: "baseline", port: 3100 };
const CANDIDATE = { id: "fulmine", label: "candidate", port: 3101 };

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

function git(...gitArgs) {
    return execFileSync("git", gitArgs, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function addWorktree(ref) {
    removeWorktree();
    // detached, so the ref is not checked out anywhere that could then be committed to by mistake
    git("worktree", "add", "--detach", WORKTREE_DIR, ref);
    return path.join(WORKTREE_DIR, "src", "index.js");
}

function removeWorktree() {
    if (!fs.existsSync(WORKTREE_DIR)) {
        return;
    }
    try {
        git("worktree", "remove", "--force", WORKTREE_DIR);
    } catch {
        fs.rmSync(WORKTREE_DIR, { recursive: true, force: true });
        try {
            git("worktree", "prune");
        } catch {
            // nothing left to prune
        }
    }
}

async function load(framework, scenario, request, durationSeconds, connections, pipelining) {
    const result = await autocannon({
        url: `http://127.0.0.1:${framework.port}${request.path}`,
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
            `${framework.label} answered ${result.non2xx} non-2xx out of ${result.requests.total}, ` +
                `so this round measured something other than the scenario`
        );
    }
    return result.requests.average;
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const scenarioName = args.scenario || "hello-world";
    const rounds = Number(args.rounds || 7);
    const durationSeconds = Number(args.duration || 5);
    const against = args.null ? null : args.against;

    if (!against && !args.null) {
        throw new Error("give a revision with --against <ref>, or --null to measure the noise floor");
    }

    const scenario = require(path.join(__dirname, "scenarios", `${scenarioName}.js`));
    const request = resolveRequest(scenario);
    // Fewer connections than run.js uses by default. That comparison wants both servers saturated;
    // this one wants the server to be the bottleneck rather than the scheduler, and piling on
    // connections here only widens what --null reports as the noise floor.
    const connections = Number(args.connections || 50);
    // Not 1, and it matters more than it looks. autocannon is one JS thread and tops out around
    // 20k requests a second on a laptop, which is below what either arm can serve, so without
    // pipelining both arms report the load generator's ceiling and every ratio comes back 1.00
    // whatever the change did. Measured on a change worth a fifth: 1.00 at pipelining 1, 1.17 at 10.
    const pipelining = Number(args.pipelining || 10);

    let baselineSrc = null;
    if (against) {
        process.stdout.write(`Checking out ${against} into ${path.relative(REPO_ROOT, WORKTREE_DIR)}\n`);
        baselineSrc = addWorktree(against);
    }

    const label = against ? `${against} (baseline) vs working tree (candidate)` : "working tree against itself";
    process.stdout.write(
        `${scenario.name}: ${label}, ${rounds} rounds of ${durationSeconds}s at ${connections} connections, pipelining ${pipelining}\n\n`
    );

    const arms = [
        { framework: BASELINE, src: baselineSrc },
        { framework: CANDIDATE, src: null }
    ];
    const started = [];

    try {
        // both servers stay up for the whole run, so neither pays a fresh warmup that the other
        // has already amortised
        for (const arm of arms) {
            const env = arm.src ? { FULMINE_SRC: arm.src, NODE_ENV: "production" } : { NODE_ENV: "production" };
            const handle = startScenarioServer(arm.framework, scenarioName, env);
            await waitForReady(handle.server, arm.framework, scenarioName);
            started.push(handle);
        }

        // Rounds nobody records. Whichever server is hit first is hit cold, and the difference is
        // not small: with no warmup at all the first baseline round came out 60% away from every
        // round that followed it, purely because it was the one that paid for warming up. One
        // round was not enough either, the machine was still ramping into the second.
        const WARMUP_ROUNDS = 2;
        for (let i = 0; i < WARMUP_ROUNDS; i++) {
            process.stdout.write(`warmup ${i + 1}/${WARMUP_ROUNDS} (not recorded)\n`);
            await load(BASELINE, scenario, request, durationSeconds, connections, pipelining);
            await load(CANDIDATE, scenario, request, durationSeconds, connections, pipelining);
        }

        const ratios = [];
        for (let round = 0; round < rounds; round++) {
            // alternate who goes first, so a warming or throttling trend does not always land on
            // the same arm
            const baselineFirst = round % 2 === 0;
            const first = baselineFirst ? BASELINE : CANDIDATE;
            const second = baselineFirst ? CANDIDATE : BASELINE;

            const firstReq = await load(first, scenario, request, durationSeconds, connections, pipelining);
            const secondReq = await load(second, scenario, request, durationSeconds, connections, pipelining);

            const baseline = baselineFirst ? firstReq : secondReq;
            const candidate = baselineFirst ? secondReq : firstReq;
            ratios.push(candidate / baseline);

            process.stdout.write(
                `round ${round + 1}: baseline ${Math.round(baseline)} req/s, ` +
                    `candidate ${Math.round(candidate)} req/s, ratio ${(candidate / baseline).toFixed(4)}\n`
            );
        }

        ratios.sort((a, b) => a - b);
        const median = ratios[Math.floor(ratios.length / 2)];
        process.stdout.write(
            `\nmedian candidate/baseline: ${median.toFixed(4)} (${((median - 1) * 100).toFixed(2)}%)\n` +
                `spread: ${ratios[0].toFixed(4)} .. ${ratios[ratios.length - 1].toFixed(4)}\n`
        );
        if (args.null) {
            process.stdout.write(
                "\nBoth arms ran the same code, so this is the noise floor. A real change has to " +
                    "move the median further than this to mean anything.\n"
            );
        }
    } finally {
        for (const handle of started) {
            await stopScenarioServer(handle.server, handle.stderrRef);
        }
        if (against) {
            removeWorktree();
        }
    }
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    removeWorktree();
    process.exit(1);
});
