"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn } = require("child_process");
const autocannon = require("autocannon");

const SCENARIO_FILES = fs
    .readdirSync(path.join(__dirname, "scenarios"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => file.replace(".js", ""));

const FRAMEWORKS = [
    { id: "express", label: "Express", port: 3001 },
    { id: "fulmine", label: "Fulmine", port: 3000 }
];

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

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForReady(port, timeoutMs = 10000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tryReady = () => {
            const request = http.get({ host: "127.0.0.1", port, path: "/__ready" }, (response) => {
                response.resume();
                if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
                    resolve();
                    return;
                }
                if (Date.now() - start > timeoutMs) {
                    reject(new Error(`Timeout waiting for server on port ${port}`));
                    return;
                }
                setTimeout(tryReady, 200);
            });

            request.on("error", () => {
                if (Date.now() - start > timeoutMs) {
                    reject(new Error(`Timeout waiting for server on port ${port}`));
                    return;
                }
                setTimeout(tryReady, 200);
            });
        };

        tryReady();
    });
}

function startScenarioServer(framework, scenarioName) {
    const serverScript = path.join(__dirname, "server.js");
    const serverArgs = [
        serverScript,
        "--framework",
        framework.id,
        "--scenario",
        scenarioName,
        "--port",
        String(framework.port)
    ];

    const server = spawn(process.execPath, serverArgs, {
        cwd: path.join(__dirname, ".."),
        stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";
    server.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
    });

    return { server, stderrRef: () => stderr };
}

async function stopScenarioServer(server, stderrRef) {
    if (server.exitCode === null) {
        server.kill("SIGTERM");
        await wait(300);
        if (server.exitCode === null) {
            server.kill("SIGKILL");
        }
    }

    const stderr = stderrRef();
    if (stderr.trim()) {
        process.stderr.write(stderr);
    }
}

function runHttpRequest(port, request, timeoutMs = 30000) {
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
                host: "127.0.0.1",
                port,
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
            await waitForReady(framework.port);
            results[framework.id] = await runHttpRequest(framework.port, request);
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

async function runScenario(framework, scenarioName, scenario, durationSeconds) {
    const { server, stderrRef } = startScenarioServer(framework, scenarioName);

    try {
        await waitForReady(framework.port);

        const load = scenario.load || {};
        const request = resolveRequest(scenario);

        const result = await autocannon({
            // the path goes in the url: autocannon only honours a top-level `path` through the
            // `requests` array, so passing it alongside `url` silently sends every request to /
            url: `http://127.0.0.1:${framework.port}${request.path}`,
            method: request.method,
            headers: request.headers,
            body: request.body ?? undefined,
            connections: load.connections || 200,
            workers: load.workers || undefined,
            duration: durationSeconds,
            // the generator shares the machine with the server, so it has to be told not to wait
            // forever on a request the server is too busy to answer
            timeout: 30
        });

        const requestsPerSec = result.requests.average;
        if (!requestsPerSec) {
            throw new Error(
                `no completed requests for ${framework.id}/${scenarioName}: ` +
                    `${result.errors} errors, ${result.timeouts} timeouts, ${result.non2xx} non-2xx`
            );
        }

        // a run that answered anything other than 2xx/3xx did not measure the scenario
        if (result.non2xx > 0) {
            throw new Error(
                `${framework.id}/${scenarioName} served ${result.non2xx} non-2xx/3xx responses out of ` +
                    `${result.requests.total}, so this run measured something other than the scenario`
            );
        }

        const socketErrors = result.errors + result.timeouts;

        return {
            requestsPerSec,
            transferPerSecBytes: result.throughput.average,
            latencyP50: result.latency.p50,
            latencyP99: result.latency.p99,
            socketErrorLine:
                socketErrors > 0
                    ? `errors ${result.errors}, timeouts ${result.timeouts}, out of ${result.requests.total} requests`
                    : null
        };
    } finally {
        await stopScenarioServer(server, stderrRef);
    }
}

function buildMarkdown(results) {
    const lines = [];
    lines.push("<!-- benchmark-comment -->");
    lines.push("## Benchmark Comparison");
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
        const speedup =
            row.express.ok && row.ultimate.ok && row.express.requestsPerSec > 0
                ? `${(row.ultimate.requestsPerSec / row.express.requestsPerSec).toFixed(2)}x`
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
            lines.push(`- \`${entry.scenario}\`: ${entry.by}${entry.ceiling ? ` — ceiling ${entry.ceiling}` : ""}`);
        }
    }

    if (unvalidated.length > 0) {
        lines.push("");
        lines.push(
            `> :warning: ${unvalidated.length} scenario(s) did not pass response validation: express and uExpress did not return the same status and body, so their numbers are not comparable.`
        );
        lines.push("");
        lines.push("### Failed Response Validation");
        lines.push("");
        for (const entry of unvalidated) {
            lines.push(`- \`${entry.scenario}\`\n\`\`\`\n${entry.message}\n\`\`\``);
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
                message: error.stack || error.message || String(error)
            };
            process.stderr.write(`[validation] ERROR ${scenario.name}: ${validation.message}\n`);
        }

        let expressResult;
        try {
            const successfulResult = await runScenario(FRAMEWORKS[0], scenarioName, scenario, durationSeconds);
            expressResult = {
                ok: true,
                ...successfulResult
            };
        } catch (error) {
            expressResult = {
                ok: false,
                error: error.stack || error.message || String(error)
            };
            process.stderr.write(`[benchmark] FAILED express/${scenarioName}\n${expressResult.error}\n`);
        }

        let ultimateResult;
        try {
            const successfulResult = await runScenario(FRAMEWORKS[1], scenarioName, scenario, durationSeconds);
            ultimateResult = {
                ok: true,
                ...successfulResult
            };
        } catch (error) {
            ultimateResult = {
                ok: false,
                error: error.stack || error.message || String(error)
            };
            process.stderr.write(`[benchmark] FAILED fulmine/${scenarioName}\n${ultimateResult.error}\n`);
        }

        results.push({
            name: scenario.name,
            bound: scenario.bound || null,
            validation,
            express: expressResult,
            ultimate: ultimateResult
        });

        process.stdout.write(`Done: ${scenario.name}\n`);
    }

    const successfulRows = results.filter((row) => row.express.ok || row.ultimate.ok);
    if (successfulRows.length === 0) {
        throw new Error("All benchmark scenarios failed. No summary table generated.");
    }

    results.sort((a, b) => a.name.localeCompare(b.name));

    const markdown = buildMarkdown(results);
    fs.writeFileSync(outputPath, markdown, "utf8");
    process.stdout.write(markdown);
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
});
