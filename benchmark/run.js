"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const crypto = require("crypto");
const autocannon = require("autocannon");
const { startScenarioServer, waitForReady, stopScenarioServer } = require("./harness.js");
const {
    machineKey,
    looseKey,
    readHistory,
    runRecordOf,
    baselineFor,
    appendRun,
    historyMarkdown,
    median
} = require("./history.js");

const SCENARIO_FILES = fs
    .readdirSync(path.join(__dirname, "scenarios"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => file.replace(".js", ""));

const FRAMEWORKS = [
    { id: "express", label: "Express", port: 3001 },
    { id: "fulmine", label: "Fulmine", port: 3000 }
];

/**
 * Puts both arms on a unix socket instead of a TCP port, when `--socket` asked for it.
 *
 * The question this exists to answer is whether the loopback stack is part of what makes a row
 * move ten percent between two runs of the same code. It is asked rather than assumed, because the
 * answer is not free either way: the two arms do not necessarily pay the same for a change of
 * transport, and a ratio that moves because µWS and node:net differ on AF_UNIX has stopped saying
 * anything about the frameworks. Run it both ways and compare the ratios, not the throughput.
 *
 * @param {boolean} wanted
 */
function useSockets(wanted) {
    if (!wanted) {
        return;
    }
    if (process.platform === "win32") {
        throw new Error("--socket needs a unix socket, and this is Windows. Run it on the CI or a mac.");
    }
    for (const framework of FRAMEWORKS) {
        framework.socketPath = path.join(os.tmpdir(), `fulmine-bench-${framework.id}-${process.pid}.sock`);
        // a socket left behind by a killed run would refuse the bind
        try {
            fs.unlinkSync(framework.socketPath);
        } catch {
            // there was none, which is the normal case
        }
    }
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const value = argv[i];
        if (value.startsWith("--")) {
            args[value.slice(2)] = argv[i + 1];
            i++;
        }
    }
    return args;
}

function runHttpRequest(framework, request, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const method = request.method || "GET";
        const pathName = request.path || "/";
        const headers = { ...(request.headers || {}) };
        const body = request.body || null;

        if (body && headers["Content-Length"] == null && headers["content-length"] == null) {
            headers["Content-Length"] = String(Buffer.byteLength(body));
        }

        const req = http.request(
            {
                // a socket path and a host/port are alternatives here, as they are for node's
                // own server: whichever the run asked for is what both arms are reached on
                ...(framework.socketPath
                    ? { socketPath: framework.socketPath }
                    : { host: "127.0.0.1", port: framework.port }),
                path: pathName,
                method,
                headers
            },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const rawBody = Buffer.concat(chunks);
                    let decodedBody = rawBody;
                    try {
                        const contentEncoding = String(res.headers["content-encoding"] || "")
                            .toLowerCase()
                            .split(",")[0]
                            .trim();
                        if (contentEncoding === "gzip") {
                            decodedBody = zlib.gunzipSync(rawBody);
                        } else if (contentEncoding === "deflate") {
                            decodedBody = zlib.inflateSync(rawBody);
                        } else if (contentEncoding === "br") {
                            decodedBody = zlib.brotliDecompressSync(rawBody);
                        }
                    } catch (error) {
                        reject(new Error(`Failed to decode response body: ${error.message}`));
                        return;
                    }

                    resolve({
                        statusCode: res.statusCode || 0,
                        headers: res.headers,
                        bodyHash: crypto.createHash("sha256").update(decodedBody).digest("hex"),
                        bodySize: decodedBody.length
                    });
                });
            }
        );

        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
        });
        req.on("error", reject);

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

// The request a scenario issues, resolved once and used both for validation and for the load run.
// Keeping these as one definition is deliberate: they used to be two - a `verify` block here and a
// separate wrk lua script - and when one of the scripts was renamed the load run silently fell back
// to GET / and measured a 404 for 34 published runs while validation carried on passing.
function resolveRequest(scenario) {
    const request = scenario.request || {};
    let body = request.body ?? null;
    if (request.bodyRepeat && typeof request.bodyRepeat === "object") {
        const repeat = request.bodyRepeat;
        body = String(repeat.char || "a").repeat(Number(repeat.count || 0));
    }
    return {
        method: request.method || "GET",
        path: request.path || scenario.path,
        headers: { ...(request.headers || {}) },
        body
    };
}

async function validateScenarioResponses(scenarioName, scenario) {
    const request = resolveRequest(scenario);
    const results = {};

    for (const framework of FRAMEWORKS) {
        const { server, stderrRef } = startScenarioServer(framework, scenarioName);
        try {
            await waitForReady(server, framework, scenarioName);
            results[framework.id] = await runHttpRequest(framework, request);
        } catch (error) {
            // say which server failed to answer. Without it the report names neither, and a
            // validation that never ran is indistinguishable from one that ran and disagreed
            throw new Error(`${framework.id} did not answer: ${error.message}`, { cause: error });
        } finally {
            await stopScenarioServer(server, stderrRef);
        }
    }

    const expressResult = results.express;
    const fulmineResult = results["fulmine"];
    const sameStatus = expressResult.statusCode === fulmineResult.statusCode;
    const sameBodyHash = expressResult.bodyHash === fulmineResult.bodyHash;

    if (sameStatus && sameBodyHash) {
        return {
            ok: true,
            message: `status ${expressResult.statusCode}, body sha256 ${expressResult.bodyHash.slice(0, 12)}`
        };
    }

    return {
        ok: false,
        message: [
            `express: status=${expressResult.statusCode}, hash=${expressResult.bodyHash}, size=${expressResult.bodySize}`,
            `fulmine: status=${fulmineResult.statusCode}, hash=${fulmineResult.bodyHash}, size=${fulmineResult.bodySize}`
        ].join(" | ")
    };
}

function formatReqPerSec(value) {
    if (value >= 1000) {
        return `${(value / 1000).toFixed(2)}k`;
    }
    return value.toFixed(2);
}

function formatBytesPerSec(bytes) {
    const units = ["B/sec", "KB/sec", "MB/sec", "GB/sec"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function formatMs(value) {
    return `${Number(value).toFixed(2)} ms`;
}

/**
 * One timed round of load against one arm. The sanity checks are per round, because a round that
 * completed nothing, or answered outside 2xx/3xx, would poison the ratio it enters.
 */
async function loadRound(framework, scenarioName, request, load, roundSeconds) {
    const result = await autocannon({
        // the path goes in the url: autocannon only honours a top-level `path` through the
        // `requests` array, so passing it alongside `url` silently sends every request to /
        url: `http://127.0.0.1${framework.socketPath ? "" : ":" + framework.port}${request.path}`,
        // autocannon dials the socket and keeps using the url only for the request line
        socketPath: framework.socketPath,
        method: request.method,
        headers: request.headers,
        body: request.body ?? undefined,
        connections: load.connections || 200,
        workers: load.workers || undefined,
        duration: roundSeconds,
        // the generator shares the machine with the server, so it has to be told not to wait
        // forever on a request the server is too busy to answer
        timeout: 30
    });

    if (!result.requests.average) {
        throw new Error(
            `no completed requests for ${framework.id}/${scenarioName}: ` +
                `${result.errors} errors, ${result.timeouts} timeouts, ${result.non2xx} non-2xx`
        );
    }

    // a round that answered anything other than 2xx/3xx did not measure the scenario
    if (result.non2xx > 0) {
        throw new Error(
            `${framework.id}/${scenarioName} served ${result.non2xx} non-2xx/3xx responses out of ` +
                `${result.requests.total}, so this run measured something other than the scenario`
        );
    }

    return {
        requestsPerSec: result.requests.average,
        transferPerSecBytes: result.throughput.average,
        latencyP50: result.latency.p50,
        latencyP99: result.latency.p99,
        errors: result.errors,
        timeouts: result.timeouts,
        totalRequests: result.requests.total
    };
}

/**
 * What one arm's rounds add up to, in the shape the table renders. Throughput is the mean of the
 * rounds, which all last the same; the latencies are the median round's, because percentiles
 * from separate passes do not add.
 */
function aggregateRounds(rounds) {
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const errors = rounds.reduce((sum, round) => sum + round.errors, 0);
    const timeouts = rounds.reduce((sum, round) => sum + round.timeouts, 0);
    const totalRequests = rounds.reduce((sum, round) => sum + round.totalRequests, 0);
    return {
        requestsPerSec: mean(rounds.map((round) => round.requestsPerSec)),
        transferPerSecBytes: mean(rounds.map((round) => round.transferPerSecBytes)),
        latencyP50: median(rounds.map((round) => round.latencyP50)),
        latencyP99: median(rounds.map((round) => round.latencyP99)),
        socketErrorLine:
            errors + timeouts > 0 ? `errors ${errors}, timeouts ${timeouts}, out of ${totalRequests} requests` : null
    };
}

/**
 * Both arms of one scenario, in alternating rounds rather than one pass each.
 *
 * With one pass per arm, whatever the machine does between minute N and minute N+1 lands whole in
 * the ratio, and that was the run-to-run wobble of the routing rows. Here both servers are up for
 * the whole scenario and the load alternates between them, swapping which goes first, the same
 * design that keeps ab.js readable on a machine that drifts: the drift lands on adjacent rounds
 * of both arms and cancels in the per-round ratio.
 *
 * The layout inside the old budget is one discarded warmup round per arm and four measured
 * rounds, all the same length. The warmup is ab.js's lesson, a first round on cold servers came
 * out far from every round after it. Four is even on purpose: the order swap gives two rounds
 * per orientation, and the median() of an even count averages the two middles, so what a
 * drifting machine adds to one orientation and subtracts from the other cancels, where a median
 * of five kept whichever orientation held the majority. The speedup is that median, so it is not
 * exactly the quotient of the two req/sec columns, which stay plain averages.
 */
async function runScenarioPair(scenarioName, scenario, durationSeconds) {
    // five equal slots per arm, one warmed through and thrown away; under 15s the slots would
    // shrink below 3s, where the connection ramp eats the round, so the old single pass stays
    const rounds = Math.floor(durationSeconds / 5) >= 3 ? 4 : 1;
    const roundSeconds = rounds === 1 ? durationSeconds : Math.floor(durationSeconds / 5);
    const request = resolveRequest(scenario);
    const load = scenario.load || {};

    const arms = FRAMEWORKS.map((framework) => ({ framework, handle: null, rounds: [], error: null }));
    try {
        for (const arm of arms) {
            try {
                arm.handle = startScenarioServer(arm.framework, scenarioName);
                await waitForReady(arm.handle.server, arm.framework, scenarioName);
            } catch (error) {
                arm.error = error;
            }
        }
        if (rounds > 1) {
            for (const arm of arms) {
                if (arm.error) {
                    continue;
                }
                try {
                    await loadRound(arm.framework, scenarioName, request, load, roundSeconds);
                } catch (error) {
                    arm.error = error;
                }
            }
        }
        for (let round = 0; round < rounds; round++) {
            for (const arm of round % 2 === 0 ? arms : [...arms].reverse()) {
                if (arm.error) {
                    continue;
                }
                try {
                    arm.rounds.push(await loadRound(arm.framework, scenarioName, request, load, roundSeconds));
                } catch (error) {
                    arm.error = error;
                }
            }
        }
    } finally {
        // each stop on its own: a stop that throws must not leave the other arm's server holding
        // a port the next scenario would bind and be misrouted on
        await Promise.allSettled(
            arms.filter((arm) => arm.handle).map((arm) => stopScenarioServer(arm.handle.server, arm.handle.stderrRef))
        );
    }

    // an arm that died mid-scenario reports FAILED rather than an average of what it managed
    const [express, fulmine] = arms.map((arm) =>
        arm.error
            ? { ok: false, error: arm.error.stack || arm.error.message || String(arm.error) }
            : { ok: true, ...aggregateRounds(arm.rounds) }
    );

    const roundRatios = [];
    if (express.ok && fulmine.ok) {
        for (let round = 0; round < arms[0].rounds.length; round++) {
            roundRatios.push(arms[1].rounds[round].requestsPerSec / arms[0].rounds[round].requestsPerSec);
        }
    }

    return {
        express,
        ultimate: fulmine,
        speedup: roundRatios.length > 0 ? median(roundRatios) : null,
        roundRatios
    };
}

function buildMarkdown(results, historySection) {
    const lines = [];
    lines.push("<!-- benchmark-comment -->");
    lines.push("## Benchmark Comparison");
    lines.push("");
    // the runner pool holds several cpu models and the ratios are machine dependent, in both
    // directions: two consecutive comments are usually two different machines, and without this
    // line the reader has no way to see that
    lines.push(`Runner: \`${machineKey()}\``);
    lines.push("");
    lines.push(
        "| Test | Express req/sec | Fulmine req/sec | Express p99 | Fulmine p99 | Express throughput | Fulmine throughput | Fulmine speedup |"
    );
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

    const failures = [];
    const unvalidated = [];
    const socketErrors = [];
    const bounded = [];
    for (const row of results) {
        // the median of the per-round ratios where the run measured in rounds, with the quotient
        // of the two averages as the single-pass fallback
        const speedup =
            row.express.ok && row.ultimate.ok && row.express.requestsPerSec > 0
                ? `${(row.speedup ?? row.ultimate.requestsPerSec / row.express.requestsPerSec).toFixed(2)}x`
                : "N/A";
        const expressReq = row.express.ok ? formatReqPerSec(row.express.requestsPerSec) : "FAILED";
        const ultimateReq = row.ultimate.ok ? formatReqPerSec(row.ultimate.requestsPerSec) : "FAILED";
        const expressTransfer = row.express.ok ? formatBytesPerSec(row.express.transferPerSecBytes) : "FAILED";
        const ultimateTransfer = row.ultimate.ok ? formatBytesPerSec(row.ultimate.transferPerSecBytes) : "FAILED";
        const expressLatency = row.express.ok ? formatMs(row.express.latencyP99) : "FAILED";
        const ultimateLatency = row.ultimate.ok ? formatMs(row.ultimate.latencyP99) : "FAILED";

        if (!row.express.ok) {
            failures.push({
                scenario: row.name,
                framework: "express",
                message: row.express.error
            });
        }
        if (!row.ultimate.ok) {
            failures.push({
                scenario: row.name,
                framework: "fulmine",
                message: row.ultimate.error
            });
        }

        // the two servers are only comparable if they answered the same thing. this was computed and
        // then never rendered, so a scenario where they diverged still looked like a clean row
        if (!row.validation || !row.validation.ok) {
            unvalidated.push({
                scenario: row.name,
                // a validation that threw never compared anything, so it must not be reported as
                // the two servers having disagreed
                ran: row.validation ? row.validation.ran !== false : false,
                message: row.validation ? row.validation.message : "validation did not run"
            });
        }

        for (const [framework, result] of [
            ["express", row.express],
            ["fulmine", row.ultimate]
        ]) {
            if (result.ok && result.socketErrorLine) {
                socketErrors.push({ scenario: row.name, framework, message: result.socketErrorLine });
            }
        }

        // some scenarios are dominated by work both frameworks hand to the same library, so their
        // ratio is capped no matter how fast either framework is. mark them instead of letting the
        // number read as "the frameworks are equivalent"
        if (row.bound) {
            bounded.push({ scenario: row.name, by: row.bound.by, ceiling: row.bound.ceiling });
        }

        const marker = (!row.validation || !row.validation.ok ? " :warning:" : "") + (row.bound ? " †" : "");
        lines.push(
            `| ${row.name}${marker} | ${expressReq} | ${ultimateReq} | ${expressLatency} | ${ultimateLatency} | ${expressTransfer} | ${ultimateTransfer} | **${speedup}** |`
        );
    }

    if (bounded.length > 0) {
        lines.push("");
        lines.push(
            "† These rows are dominated by work neither framework performs itself, so the ratio is capped regardless of how fast either one is. They are kept because they are real workloads, not because they discriminate between the two."
        );
        lines.push("");
        for (const entry of bounded) {
            lines.push(`- \`${entry.scenario}\`: ${entry.by}${entry.ceiling ? `, ceiling ${entry.ceiling}` : ""}`);
        }
    }

    if (historySection) {
        lines.push(historySection);
    }

    if (unvalidated.length > 0) {
        const disagreed = unvalidated.filter((entry) => entry.ran).length;
        const neverRan = unvalidated.length - disagreed;
        const reasons = [];
        if (disagreed > 0) {
            reasons.push(`${disagreed} where Express and Fulmine did not return the same status and body`);
        }
        if (neverRan > 0) {
            reasons.push(`${neverRan} where the check could not run at all, so nothing was compared`);
        }

        lines.push("");
        lines.push(
            `> :warning: ${unvalidated.length} scenario(s) are unvalidated: ${reasons.join(", and ")}. ` +
                `Their numbers are not comparable either way.`
        );
        lines.push("");
        lines.push("### Unvalidated Scenarios");
        lines.push("");
        for (const entry of unvalidated) {
            const what = entry.ran ? "responses differ" : "check did not run";
            lines.push(`- \`${entry.scenario}\` (${what})\n\`\`\`\n${entry.message}\n\`\`\``);
        }
    }

    if (socketErrors.length > 0) {
        lines.push("");
        lines.push(
            `> ${socketErrors.length} run(s) reported socket errors. Throughput measured alongside socket errors reflects the load generator as much as the server.`
        );
        lines.push("");
        lines.push("### Socket Errors");
        lines.push("");
        for (const entry of socketErrors) {
            lines.push(`- \`${entry.scenario}\` on \`${entry.framework}\`: ${entry.message}`);
        }
    }

    if (failures.length > 0) {
        lines.push("");
        lines.push(`> Warning: ${failures.length} benchmark run(s) failed. See details below.`);
        lines.push("");
        lines.push("### Failed Scenarios");
        lines.push("");
        for (const failure of failures) {
            lines.push(`- \`${failure.scenario}\` on \`${failure.framework}\`\n\`\`\`\n${failure.message}\n\`\`\``);
        }
    }

    lines.push("");
    return `${lines.join("\n")}\n`;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const durationSeconds = Number(args.duration || 20);
    const outputPath = path.resolve(process.cwd(), args.output || "benchmark_summary.md");
    // where the previous run on this machine was left, and where this one goes. `--history none`
    // turns it off; there is no `--no-history` because the argument parser always eats the next token
    const historyFile =
        args.history === "none" ? null : path.resolve(process.cwd(), args.history || "benchmark_history.json");
    useSockets(args.socket !== undefined && args.socket !== "false");
    const requestedScenario = args.scenario;
    const scenarioList = requestedScenario ? [requestedScenario] : SCENARIO_FILES;

    const results = [];
    for (const scenarioName of scenarioList) {
        const scenario = require(path.join(__dirname, "scenarios", `${scenarioName}.js`));
        process.stdout.write(`Running scenario: ${scenario.name}\n`);
        let validation;

        try {
            validation = await validateScenarioResponses(scenarioName, scenario);
            if (validation.ok) {
                process.stdout.write(`[validation] PASS ${scenario.name}: ${validation.message}\n`);
            } else {
                process.stderr.write(`[validation] FAIL ${scenario.name}: ${validation.message}\n`);
            }
        } catch (error) {
            validation = {
                ok: false,
                // it never got as far as comparing anything, which is a different thing to report
                ran: false,
                message: error.stack || error.message || String(error)
            };
            process.stderr.write(`[validation] ERROR ${scenario.name}: ${validation.message}\n`);
        }

        let pair;
        try {
            pair = await runScenarioPair(scenarioName, scenario, durationSeconds);
        } catch (error) {
            const failure = { ok: false, error: error.stack || error.message || String(error) };
            pair = { express: failure, ultimate: failure, speedup: null, roundRatios: [] };
        }
        if (!pair.express.ok) {
            process.stderr.write(`[benchmark] FAILED express/${scenarioName}\n${pair.express.error}\n`);
        }
        if (!pair.ultimate.ok) {
            process.stderr.write(`[benchmark] FAILED fulmine/${scenarioName}\n${pair.ultimate.error}\n`);
        }
        if (pair.roundRatios.length > 1) {
            // the spread of these is what says whether the row's number can be trusted at all
            process.stdout.write(
                `[rounds] ${scenario.name}: ${pair.roundRatios.map((ratio) => ratio.toFixed(2)).join(" ")}, ` +
                    `median ${pair.speedup.toFixed(2)}\n`
            );
        }

        results.push({
            name: scenario.name,
            bound: scenario.bound || null,
            validation,
            express: pair.express,
            ultimate: pair.ultimate,
            speedup: pair.speedup,
            roundRatios: pair.roundRatios
        });

        process.stdout.write(`Done: ${scenario.name}\n`);
    }

    const successfulRows = results.filter((row) => row.express.ok || row.ultimate.ok);
    if (successfulRows.length === 0) {
        throw new Error("All benchmark scenarios failed. No summary table generated.");
    }

    results.sort((a, b) => a.name.localeCompare(b.name));

    // twenty minutes of measurement must not be thrown away because a file could not be written,
    // so everything here is best effort and says so rather than failing the run
    let historySection = null;
    if (historyFile) {
        try {
            const key = machineKey();
            const history = readHistory(historyFile);
            const baseline = baselineFor(history, key, looseKey());
            const record = runRecordOf(results);
            historySection = historyMarkdown(baseline, record);
            appendRun(historyFile, history, key, record);
            process.stdout.write(
                `[history] ${Object.keys(record.scenarios).length} scenario(s) under ${key}` +
                    `${
                        baseline
                            ? `, compared against ${baseline.run.commit || baseline.run.at}${baseline.exact ? "" : " on another cpu"}`
                            : ", nothing to compare against yet"
                    }\n`
            );
        } catch (error) {
            process.stderr.write(`[history] skipped: ${error.message}\n`);
        }
    }

    const markdown = buildMarkdown(results, historySection);
    fs.writeFileSync(outputPath, markdown, "utf8");
    process.stdout.write(markdown);
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
});
