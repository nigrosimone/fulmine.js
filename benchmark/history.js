"use strict";

// What a benchmark run leaves behind for the next one to compare against.
//
// The number kept is the speedup, fulmine over express, and not the throughput. Both arms run on
// the same machine in the same run, so a slow neighbour or a warm cache moves them together and
// the ratio holds still: that is what makes two runs comparable at all, since a hosted runner is
// never the same machine twice.
//
// Two things still move a ratio without a line of this project changing, so both go in the key and
// a run is only compared against one that matches: the machine, and the major version of node. The
// second one has bitten already, when node:http got faster between 22 and 24 and every ratio here
// dropped without a regression behind it.
//
// The raw req/sec of both arms is kept alongside the ratio. It is not comparable across runs, but
// when a ratio does move it says which arm moved, which is the difference between a regression here
// and express getting faster.

const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

// how many runs to keep per machine, which is enough to see a slide rather than a step
const KEEP = 20;

// this benchmark's noise floor, measured by running it twice on the same tree: anything under it
// is weather. Marking only what clears it is the whole point of keeping a history, since a table
// of twelve ratios always has one that moved a few percent
const NOTABLE = 0.1;

/**
 * The shape of this machine without the cpu model: same platform, same width, same major node.
 * A hosted runner pool holds more than one cpu, so this is often the only key two runs share.
 *
 * @returns {string}
 */
function looseKey() {
    return `${os.platform()}-${os.arch()}-${os.cpus().length}c-node${process.versions.node.split(".")[0]}`;
}

/**
 * What this machine is, as far as a benchmark is concerned. The cpu model is in it because two
 * cpus do not produce the same ratios even on the same code: uWS and node:http do not scale with
 * cores and memory bandwidth the same way.
 *
 * @returns {string}
 */
function machineKey() {
    const model = (os.cpus()[0]?.model || "unknown")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
    return `${looseKey()}-${model}`;
}

/**
 * Reads the history file, answering an empty one when it is missing or unreadable: a first run, or
 * an artifact that has expired, is not a reason to fail a benchmark.
 *
 * @param {string} file
 * @returns {Record<string, object[]>}
 */
function readHistory(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Which commit this is, for naming the run being compared against. Best effort: a checkout without
 * git history, or no git at all, only costs the label.
 *
 * @returns {string|null}
 */
function currentCommit() {
    if (process.env.GITHUB_SHA) {
        return process.env.GITHUB_SHA.slice(0, 7);
    }
    try {
        return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() || null;
    } catch {
        return null;
    }
}

/**
 * This run, in the shape the history keeps, leaving out the scenarios where either arm failed:
 * a failed arm has no ratio, and writing one down as zero would read as a total regression.
 *
 * @param {any[]} results rows as run.js builds them
 * @returns {{at: string, commit: string|null, node: string, scenarios: Record<string, object>}}
 */
function runRecordOf(results) {
    const scenarios = {};
    for (const row of results) {
        if (row.express.ok && row.ultimate.ok && row.express.requestsPerSec > 0) {
            scenarios[row.name] = {
                speedup: Number((row.ultimate.requestsPerSec / row.express.requestsPerSec).toFixed(4)),
                express: Math.round(row.express.requestsPerSec),
                fulmine: Math.round(row.ultimate.requestsPerSec)
            };
        }
    }
    return {
        at: new Date().toISOString(),
        commit: currentCommit(),
        node: process.versions.node,
        scenarios
    };
}

/**
 * The most recent run recorded under one key, or null when there is none.
 *
 * @param {Record<string, object[]>} history
 * @param {string} key
 * @returns {any}
 */
function lastRunFor(history, key) {
    const runs = history[key];
    return Array.isArray(runs) && runs.length > 0 ? runs[runs.length - 1] : null;
}

/**
 * What to compare this run against: the last run on this exact machine, or failing that the last
 * one on a machine of the same shape with a different cpu. The second is a weaker comparison and
 * is reported as such, but on a hosted runner pool it is usually the only one there is.
 *
 * @param {Record<string, object[]>} history
 * @param {string} exact
 * @param {string} loose
 * @returns {{run: any, exact: boolean, key: string}|null}
 */
function baselineFor(history, exact, loose) {
    const here = lastRunFor(history, exact);
    if (here) {
        return { run: here, exact: true, key: exact };
    }

    let best = null;
    for (const key of Object.keys(history)) {
        if (key === exact || !key.startsWith(`${loose}-`)) {
            continue;
        }
        const run = lastRunFor(history, key);
        if (run && (!best || String(run.at) > String(best.run.at))) {
            best = { run, exact: false, key };
        }
    }
    return best;
}

/**
 * Appends this run and writes the file back, keeping the last KEEP runs per machine.
 *
 * @param {string} file
 * @param {Record<string, object[]>} history
 * @param {string} key
 * @param {object} run
 */
function appendRun(file, history, key, run) {
    const runs = Array.isArray(history[key]) ? history[key] : [];
    runs.push(run);
    history[key] = runs.slice(-KEEP);
    fs.writeFileSync(file, JSON.stringify(history, null, 2) + "\n", "utf8");
}

/**
 * Scenario by scenario, what moved between two runs on the same machine.
 *
 * @param {any} previous
 * @param {any} current
 * @returns {{rows: any[], added: string[], missing: string[]}}
 */
function compareRuns(previous, current) {
    const before = previous.scenarios || {};
    const after = current.scenarios || {};
    const rows = [];

    for (const name of Object.keys(after)) {
        if (!before[name]) {
            continue;
        }
        const change = after[name].speedup / before[name].speedup - 1;
        rows.push({
            name,
            before: before[name],
            after: after[name],
            change,
            notable: Math.abs(change) >= NOTABLE
        });
    }

    // biggest movement first: the reason to read this section at all is the rows that moved
    rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    return {
        rows,
        added: Object.keys(after).filter((name) => !before[name]),
        missing: Object.keys(before).filter((name) => !after[name])
    };
}

/**
 * The section of the summary that compares this run against the last one on this machine, or null
 * when there is nothing to compare against.
 *
 * @param {{run: any, exact: boolean, key: string}|null} baseline
 * @param {any} current
 * @returns {string|null}
 */
function historyMarkdown(baseline, current) {
    if (!baseline) {
        return null;
    }

    const previous = baseline.run;
    const { rows, added, missing } = compareRuns(previous, current);
    if (rows.length === 0) {
        return null;
    }

    const label = [
        previous.commit ? `\`${previous.commit}\`` : null,
        previous.at ? previous.at.slice(0, 16).replace("T", " ") : null
    ]
        .filter(Boolean)
        .join(", ");

    const lines = [];
    lines.push("");
    lines.push(
        `### Against the last run on ${baseline.exact ? "this machine" : "a machine of the same shape"}${label ? ` (${label})` : ""}`
    );
    lines.push("");
    lines.push("| Test | Speedup then | Speedup now | Change | Express then → now | Fulmine then → now |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");

    for (const row of rows) {
        const percent = `${row.change >= 0 ? "+" : ""}${(row.change * 100).toFixed(1)}%`;
        // the two are read differently and deserve different marks: one is something to look at
        // now, the other is something that went right and is worth keeping
        const mark = row.notable ? (row.change < 0 ? " :eyes:" : " :trophy:") : "";
        lines.push(
            `| ${row.name}${mark} | ${row.before.speedup.toFixed(2)}x | ` +
                `${row.after.speedup.toFixed(2)}x | ${row.notable ? `**${percent}**` : percent} | ` +
                `${row.before.express} → ${row.after.express} | ${row.before.fulmine} → ${row.after.fulmine} |`
        );
    }

    lines.push("");
    lines.push(
        `Only the ratio is comparable across runs: the absolute req/sec are not, and are shown only to say ` +
            `which arm moved. This benchmark's noise floor is about ±${Math.round(NOTABLE * 100)}%, so only the ` +
            `marked rows are worth reading, and even those are worth a second run before they are worth a ` +
            `bisect. :eyes: is a ratio that fell that far, :trophy: one that rose that far.`
    );

    if (!baseline.exact) {
        lines.push("");
        lines.push(
            `> :warning: The previous run was on \`${baseline.key}\` and this one on \`${machineKey()}\`: same ` +
                `platform, same width, same major node, different cpu. Two cpus do not produce the same ratios, ` +
                `so this comparison is weaker than the noise floor above suggests.`
        );
    }

    if (added.length > 0) {
        lines.push("");
        lines.push(`New since the last run, so nothing to compare: ${added.map((name) => `\`${name}\``).join(", ")}.`);
    }
    if (missing.length > 0) {
        lines.push("");
        lines.push(
            `Measured last time and not this time, either removed or failed: ${missing.map((name) => `\`${name}\``).join(", ")}.`
        );
    }

    return lines.join("\n");
}

module.exports = {
    machineKey,
    looseKey,
    readHistory,
    runRecordOf,
    lastRunFor,
    baselineFor,
    appendRun,
    compareRuns,
    historyMarkdown,
    NOTABLE
};
