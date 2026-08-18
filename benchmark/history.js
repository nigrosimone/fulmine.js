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
// and express getting faster. Since 2026-08-18 the ratio is the median of alternating rounds and
// the record carries their spread, so a number written before that date does not compare with a
// new one on equal terms: the old single-pass ratios wobble more.

const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

// how many runs to keep per machine, which is enough to see a slide rather than a step
const KEEP = 20;

// this benchmark's noise floor, measured by running it twice on the same tree: anything under it
// is weather. Marking only what clears it is the whole point of keeping a history, since a table
// of twelve ratios always has one that moved a few percent
const NOTABLE = 0.1;

// how many recent runs the band is learned from. Against a single run the flat floor fired on one
// to three rows of nearly every recorded section, measured over 45 of them: a single 20s pass per
// arm has a p90 wobble of 13 to 19% on the routing rows, so one bad window flags twice, once going
// in and once on the recovery. Five runs is enough to hold the band and short enough to follow a
// real step
const WINDOW = 5;

// how many non-bound rows with a real window it takes to trust a table-wide shift. With fewer,
// a median of positions carries an error of several percent of its own, and dividing that into
// every row can move a quiet row across the floor by itself
const SHIFT_ROWS = 10;

/**
 * The middle value, or the average of the two middles on an even count. The average matters on
 * even counts: the measured rounds alternate which arm goes first, so taking either middle alone
 * would keep the drift that one orientation adds and the other subtracts.
 *
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

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
            // the median of the per-round ratios when the run measured in rounds; the quotient of
            // the two averages is the single-pass fallback and what the old records hold
            const speedup = row.speedup ?? row.ultimate.requestsPerSec / row.express.requestsPerSec;
            scenarios[row.name] = {
                speedup: Number(speedup.toFixed(4)),
                express: Math.round(row.express.requestsPerSec),
                fulmine: Math.round(row.ultimate.requestsPerSec)
            };
            // the spread of the rounds travels with the number, so a later reader can tell a
            // stable measurement from one that straddled two levels
            if (Array.isArray(row.roundRatios) && row.roundRatios.length > 1) {
                scenarios[row.name].spread = [
                    Number(Math.min(...row.roundRatios).toFixed(4)),
                    Number(Math.max(...row.roundRatios).toFixed(4))
                ];
            }
            // carried so the comparison can leave the row unmarked: a bound ratio cannot really
            // move, so a flag on it is weather by construction. The summary's own footnote says so
            if (row.bound) {
                scenarios[row.name].bound = true;
            }
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
        // the recent window rides along: the band a row is judged against is learned from it,
        // rather than from the single last run, whose own bad 20s window would flag twice
        return { run: here, runs: history[exact].slice(-WINDOW), exact: true, key: exact };
    }

    let best = null;
    for (const key of Object.keys(history)) {
        if (key === exact || !key.startsWith(`${loose}-`)) {
            continue;
        }
        const run = lastRunFor(history, key);
        if (run && (!best || String(run.at) > String(best.run.at))) {
            best = { run, runs: history[key].slice(-WINDOW), exact: false, key };
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
 * The change shown is against the last run, which is what a reader wants to see. Whether it is
 * marked is decided against the recent window instead, when there is one, and after dividing out
 * the shift the whole table shares: a hosted runner's sessions cap the fast arm at different
 * heights, which moves every capped ratio together, and that shared part says nothing about the
 * code. The run on 5f5fc98 is the recorded case: six routing rows flagged 11 to 19% down, a
 * table-wide shift of -4.8%, and a local A/B reading the change itself at 1.00; dividing the
 * shift out leaves one flag of the six.
 *
 * The division has a limit, because a change that slows code every scenario passes through has
 * exactly the same shape. Every recorded machine shift sat within +-7%, so a table move past the
 * noise floor is not divided out: those rows flag raw, and the footer says the move is either the
 * machine or the code and that only an A/B can tell them apart. A row is notable only when it
 * left the whole range the window stayed in AND, shift aside, sits at least the noise floor from
 * the window median; a row seen in a single window run is judged by the flat floor alone and
 * takes no part in the shift. A bound row is never marked: its ratio cannot really move, the
 * main table's own footnote says so, and its twelve recorded flags were all weather.
 *
 * @param {any} previous
 * @param {any} current
 * @param {any[]} [windowRuns] recent runs under the same key, oldest first; absent means only the
 *   previous run is known and the flat floor decides alone
 * @returns {{rows: any[], added: string[], missing: string[], shift: number, tableMove: number}}
 */
function compareRuns(previous, current, windowRuns) {
    const before = previous.scenarios || {};
    const after = current.scenarios || {};
    const runs = Array.isArray(windowRuns) && windowRuns.length > 0 ? windowRuns : [previous];

    // each row's position against its own window median, kept before judging any of them: the
    // part of it the whole table shares is the machine, and is divided out first
    const measured = [];
    for (const name of Object.keys(after)) {
        if (!before[name]) {
            continue;
        }
        const seen = runs.map((run) => run.scenarios?.[name]?.speedup).filter((speedup) => typeof speedup === "number");
        const sorted = [...seen].sort((a, b) => a - b);
        const now = after[name].speedup;
        measured.push({
            name,
            bound: Boolean(after[name].bound || before[name].bound),
            hasWindow: sorted.length > 1,
            change: now / before[name].speedup - 1,
            // against the previous run alone when the window holds nothing more; the range
            // condition is then vacuous, which is what the flat floor always was
            position: sorted.length > 1 ? now / median(sorted) : now / before[name].speedup,
            out: sorted.length > 1 ? now < sorted[0] || now > sorted[sorted.length - 1] : true
        });
    }

    // only rows with a real window vote on the shift: a single-observation position is a change
    // against one run, not a place in a band
    const positions = measured.filter((entry) => !entry.bound && entry.hasWindow).map((entry) => entry.position);
    const tableMove = positions.length >= SHIFT_ROWS ? median(positions) : 1;
    const shift = Math.abs(tableMove - 1) < NOTABLE ? tableMove : 1;

    const rows = measured.map((entry) => ({
        name: entry.name,
        before: before[entry.name],
        after: after[entry.name],
        change: entry.change,
        bound: entry.bound,
        notable: !entry.bound && entry.out && Math.abs(entry.position / (entry.hasWindow ? shift : 1) - 1) >= NOTABLE
    }));

    // biggest movement first: the reason to read this section at all is the rows that moved
    rows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    return {
        rows,
        shift,
        tableMove,
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
    const { rows, added, missing, shift, tableMove } = compareRuns(previous, current, baseline.runs);
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
    lines.push("| Test | Speedup then | Speedup now | Change | Express then to now | Fulmine then to now |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");

    for (const row of rows) {
        const percent = `${row.change >= 0 ? "+" : ""}${(row.change * 100).toFixed(1)}%`;
        // the two are read differently and deserve different marks: one is something to look at
        // now, the other is something that went right and is worth keeping
        const mark = row.notable ? (row.change < 0 ? " :eyes:" : " :trophy:") : "";
        lines.push(
            `| ${row.name}${mark} | ${row.before.speedup.toFixed(2)}x | ` +
                `${row.after.speedup.toFixed(2)}x | ${row.notable ? `**${percent}**` : percent} | ` +
                `${row.before.express} to ${row.after.express} | ${row.before.fulmine} to ${row.after.fulmine} |`
        );
    }

    const windowSize = Array.isArray(baseline.runs) ? baseline.runs.length : 1;
    const shiftClause =
        shift === 1
            ? ""
            : `, measured after dividing out the ${shift >= 1 ? "+" : ""}${((shift - 1) * 100).toFixed(1)}% the ` +
              `whole table moved against the same window, which at that size is the machine rather than the code`;
    lines.push("");
    lines.push(
        `Only the ratio is comparable across runs: the absolute req/sec are not, and are shown only to say ` +
            `which arm moved. A row is marked when it left the whole range of the last ` +
            `${windowSize} run${windowSize === 1 ? "" : "s"} on this machine and sits at least ` +
            `±${Math.round(NOTABLE * 100)}% from their median${shiftClause}; a single run still wobbles, ` +
            `so even a marked row is worth a second run before it is worth a bisect. Rows the main table ` +
            `marks as bound are never flagged, their ratio cannot really move. ` +
            `:eyes: is a ratio that fell out of the range, :trophy: one that rose out of it.`
    );

    // a table-wide move past the floor is not divided out, because a change every scenario pays
    // has the same shape as a slow session: saying "machine" here would assert what nothing in
    // this comparison can know
    if (shift === 1 && Math.abs(tableMove - 1) >= NOTABLE) {
        lines.push("");
        lines.push(
            `> :warning: The whole table sits ${tableMove >= 1 ? "+" : ""}${((tableMove - 1) * 100).toFixed(1)}% ` +
                `from the window medians. A move that size is either this runner's session or a change every ` +
                `scenario pays, and this comparison cannot tell them apart: ` +
                `\`npm run benchmark:ab -- --against ${previous.commit || "the previous commit"}\` on a flagged ` +
                `row decides.`
        );
    }

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
    median,
    NOTABLE
};
