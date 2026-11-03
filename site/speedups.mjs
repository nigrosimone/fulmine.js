// Refreshes the speedups quoted on the site and in the README: npm run speedups --prefix site
// It reads the median ratio of each scenario from the last CI benchmark runs on main (the
// "[rounds] scenario: ..., median X" lines), the µWS pass only, and writes them between the
// <!--speedup:KEY:STYLE--> markers of the pages below and into .vitepress/theme/speedups.json.
// Needs the gh CLI, logged in. KEY is a group below or a scenario name, STYLE one of:
//   to      "1.2x to 3.4x"     dash    "1.2-3.4", the slowest to the fastest CPU type
//   median  "10" or "1.5", the median across CPU types, rounded from 10 up     best "14", the fastest CPU type, for the headlines
//   cpu     "Intel Xeon Platinum 8573C", the CPU type behind best
// Runs are grouped by the runner's CPU, each type counts once: the spread between CPU types is
// most of the spread between runs, so a window that drew more of one type moved every number.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const REPO = "nigrosimone/fulmine.js";
const RUNS = Number(process.argv[2] || 40);
// a CPU type seen fewer times than this is left out of the ranges, one run is not a median
const MIN_RUNS_PER_CPU = 3;
const GROUPS = {
    plain: ["routing/hello-world", "routing/api-endpoint", "routing/query-string"],
    body: ["middlewares/body-json-echo", "middlewares/body-urlencoded"],
    tables: ["routing/routes-1000", "routing/routes-1000-params"]
};
const PAGES = ["../README.md", "../docs/index.md", "../docs/why.md", "../docs/performance.md"];

const gh = (/** @type {string[]} */ args) =>
    execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/**
 * "linux-x64-4c-node26-amd-epyc-7763-64-core-processor" as "AMD EPYC 7763".
 * @param {string} runner
 */
function cpuName(runner) {
    const words = [];
    for (const word of runner.replace(/^linux-\w+-\d+c-node\d+-/, "").split("-")) {
        // the model is the word with a digit, what follows is core count or clock
        if (words.some((w) => /\d/.test(w))) break;
        if (word === "r") continue;
        const fixed = { amd: "AMD", epyc: "EPYC" }[word];
        words.push(fixed ?? (/\d/.test(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)));
    }
    return words.join(" ");
}

const runs = JSON.parse(
    gh([
        "run",
        "list",
        "-R",
        REPO,
        "-b",
        "main",
        "-w",
        "Benchmark Express Performance",
        "--status",
        "success",
        "-L",
        String(RUNS),
        "--json",
        "databaseId,createdAt"
    ])
);
/** @type {Record<string, Record<string, number[]>>} scenario, then CPU type */
const medians = {};
/** @type {Record<string, number>} */
const runsPerCpu = {};
for (const run of runs) {
    const log = gh(["run", "view", String(run.databaseId), "-R", REPO, "--log"]);
    // the second pass serves the same scenarios through node:http, see benchmark/README.md
    const uws = log.split("run.js --shim")[0];
    const cpu = cpuName(uws.match(/Runner: `([^`]+)`/)?.[1] ?? "unknown");
    runsPerCpu[cpu] = (runsPerCpu[cpu] ?? 0) + 1;
    for (const [, name, value] of uws.matchAll(/\[rounds\] ([\w-]+\/[\w-]+): [^\n]*median ([\d.]+)/g)) {
        ((medians[name] ??= {})[cpu] ??= []).push(Number(value));
    }
}
const cpus = Object.keys(runsPerCpu).filter((cpu) => runsPerCpu[cpu] >= MIN_RUNS_PER_CPU);

/** @param {number[]} values */
const middle = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const half = sorted.length >> 1;
    return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
};

/** @typedef {{min: number, low: number, median: number, best: number, max: number, cpu: string, runs: number}} Figure */
/**
 * @param {Record<string, number[]>} byCpu
 * @returns {Figure}
 */
function summary(byCpu) {
    const all = Object.values(byCpu).flat();
    const perCpu = cpus.filter((cpu) => byCpu[cpu]).map((cpu) => ({ cpu, median: middle(byCpu[cpu]) }));
    perCpu.sort((a, b) => a.median - b.median);
    return {
        min: Math.min(...all),
        low: perCpu[0].median,
        median: middle(perCpu.map((entry) => entry.median)),
        best: perCpu[perCpu.length - 1].median,
        max: Math.max(...all),
        cpu: perCpu[perCpu.length - 1].cpu,
        runs: all.length
    };
}
/** @type {Record<string, Figure>} */
const figures = {};
for (const [name, byCpu] of Object.entries(medians)) {
    figures[name] = summary(byCpu);
}
// a group spans its scenarios: the slowest CPU on the slowest one to the fastest CPU on the fastest
for (const [group, names] of Object.entries(GROUPS)) {
    const parts = names.map((name) => figures[name]).filter(Boolean);
    const top = parts.reduce((a, b) => (b.best > a.best ? b : a));
    figures[group] = {
        min: Math.min(...parts.map((f) => f.min)),
        low: Math.min(...parts.map((f) => f.low)),
        median: middle(parts.map((f) => f.median)),
        best: top.best,
        max: Math.max(...parts.map((f) => f.max)),
        cpu: top.cpu,
        runs: parts.reduce((sum, f) => sum + f.runs, 0)
    };
}

const dates = runs.map((run) => run.createdAt.slice(0, 10)).sort();
const day = (/** @type {string} */ iso) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const period = `the last ${runs.length} CI runs on ${cpus.length} CPU types, ${day(dates[0])} to ${day(dates[dates.length - 1])}`;

const one = (/** @type {number} */ n) => n.toFixed(1);
/** @type {Record<string, (f: Figure) => string>} */
const STYLES = {
    to: (f) => `${one(f.low)}x to ${one(f.best)}x`,
    dash: (f) => `${one(f.low)}-${one(f.best)}`,
    median: (f) => (f.median < 10 ? one(f.median) : String(Math.round(f.median))),
    best: (f) => String(Math.round(f.best)),
    cpu: (f) => f.cpu
};

for (const page of PAGES) {
    const url = new URL(page, import.meta.url);
    const text = await readFile(url, "utf8");
    const out = text.replace(/<!--speedup:([\w/-]+):(\w+)-->[^<]*<!--\/speedup-->/g, (marker, key, style) => {
        const value = key === "period" ? period : figures[key] && STYLES[style]?.(figures[key]);
        if (value === undefined) {
            throw new Error(`${page}: no figure for ${key}:${style}`);
        }
        return `<!--speedup:${key}:${style}-->${value}<!--/speedup-->`;
    });
    if (out !== text) {
        await writeFile(url, out);
    }
}

// the headline is the 1,000 parameterized routes, as on the home page, and package.json says it too
const headline = Math.round(figures["routing/routes-1000-params"].best);
await writeFile(
    new URL(".vitepress/theme/speedups.json", import.meta.url),
    JSON.stringify({ period, headline, cpus: runsPerCpu, figures }, null, 4) + "\n"
);
const pkgUrl = new URL("../package.json", import.meta.url);
const pkg = await readFile(pkgUrl, "utf8");
await writeFile(pkgUrl, pkg.replace(/("description": "[^"]*up to )\d+x/, `$1${headline}x`));
for (const name of [...Object.keys(GROUPS), ...Object.keys(medians).sort()]) {
    const f = figures[name];
    console.log(`${name.padEnd(40)} ${one(f.low)}x to ${one(f.best)}x, median ${one(f.median)}x, best on ${f.cpu}`);
}
console.log(period);
console.log(
    Object.entries(runsPerCpu)
        .map(([cpu, n]) => `${cpu}: ${n}`)
        .join(", ")
);
