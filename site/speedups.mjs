// Refreshes the speedups quoted on the site and in the README: npm run speedups --prefix site
// It reads the median ratio of each scenario from the last CI benchmark runs on main (the
// "[rounds] scenario: ..., median X" lines), the µWS pass only, and writes them between the
// <!--speedup:KEY:STYLE--> markers of the pages below and into .vitepress/theme/speedups.json.
// Needs the gh CLI, logged in. KEY is a group below or a scenario name, STYLE one of:
//   to      "1.2x to 3.4x"     dash    "1.2-3.4"     median   "10", the rounded median
//   max     "22", the rounded best run, for the home page, which says it is the best run
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const REPO = "nigrosimone/fulmine.js";
const RUNS = Number(process.argv[2] || 20);
const GROUPS = {
    plain: ["routing/hello-world", "routing/api-endpoint", "routing/query-string"],
    body: ["middlewares/body-json-echo", "middlewares/body-urlencoded"],
    tables: ["routing/routes-1000", "routing/routes-1000-params"]
};
const PAGES = ["../README.md", "../docs/index.md", "../docs/why.md", "../docs/performance.md"];

const gh = (/** @type {string[]} */ args) =>
    execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

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
/** @type {Record<string, number[]>} */
const medians = {};
for (const run of runs) {
    const log = gh(["run", "view", String(run.databaseId), "-R", REPO, "--log"]);
    // the second pass serves the same scenarios through node:http, see benchmark/README.md
    const uws = log.split("run.js --shim")[0];
    for (const [, name, value] of uws.matchAll(/\[rounds\] ([\w-]+\/[\w-]+): [^\n]*median ([\d.]+)/g)) {
        (medians[name] ??= []).push(Number(value));
    }
}

/** @param {number[]} values */
function summary(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return {
        min: sorted[0],
        median: sorted[Math.floor(sorted.length / 2)],
        max: sorted[sorted.length - 1],
        runs: values.length
    };
}
/** @type {Record<string, {min: number, median: number, max: number, runs: number}>} */
const figures = {};
for (const [name, values] of Object.entries(medians)) {
    figures[name] = summary(values);
}
for (const [group, names] of Object.entries(GROUPS)) {
    figures[group] = summary(names.flatMap((name) => medians[name] ?? []));
}

const dates = runs.map((run) => run.createdAt.slice(0, 10)).sort();
const day = (/** @type {string} */ iso) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const period = `the last ${runs.length} CI runs, ${day(dates[0])} to ${day(dates[dates.length - 1])}`;

const one = (/** @type {number} */ n) => n.toFixed(1);
/** @type {Record<string, (f: {min: number, median: number, max: number}) => string>} */
const STYLES = {
    to: (f) => `${one(f.min)}x to ${one(f.max)}x`,
    dash: (f) => `${one(f.min)}-${one(f.max)}`,
    median: (f) => String(Math.round(f.median)),
    max: (f) => String(Math.round(f.max))
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

await writeFile(
    new URL(".vitepress/theme/speedups.json", import.meta.url),
    JSON.stringify({ period, headline: Math.round(figures.tables.max), figures }, null, 4) + "\n"
);
for (const name of [...Object.keys(GROUPS), ...Object.keys(medians).sort()]) {
    const f = figures[name];
    console.log(`${name.padEnd(40)} ${one(f.min)}x to ${one(f.max)}x, median ${one(f.median)}x over ${f.runs}`);
}
console.log(period);
