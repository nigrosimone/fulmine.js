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

const fs = require("fs");
const os = require("os");

// how many runs to keep per machine, which is enough to see a slide rather than a step
const KEEP = 20;

/**
 * What this machine is, as far as a benchmark is concerned. The cpu model is in it because a
 * runner pool holds more than one, and they do not produce the same ratios.
 *
 * @returns {string}
 */
function machineKey() {
    const cpus = os.cpus();
    const model = (cpus[0]?.model || "unknown")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
    return `${os.platform()}-${os.arch()}-${cpus.length}c-node${process.versions.node.split(".")[0]}-${model}`;
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
 * The speedups this run measured, by scenario, leaving out the ones where either arm failed.
 *
 * @param {any[]} results rows as run.js builds them
 * @returns {Record<string, number>}
 */
function speedupsOf(results) {
    const speedups = {};
    for (const row of results) {
        if (row.express.ok && row.ultimate.ok && row.express.requestsPerSec > 0) {
            speedups[row.name] = row.ultimate.requestsPerSec / row.express.requestsPerSec;
        }
    }
    return speedups;
}

/**
 * The most recent run recorded for this machine, or null when there is none to compare against.
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

module.exports = { machineKey, readHistory, speedupsOf, lastRunFor, appendRun };
