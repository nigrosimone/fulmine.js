// Refreshes the speedups quoted on the site and in the README: npm run speedups --prefix site
// It reads the median ratio of each scenario from the last CI benchmark runs on main (the
// "[rounds] scenario: ..., median X" lines), the µWS pass only, and writes them between the
// <!--speedup:KEY:STYLE--> markers of the pages below and into .vitepress/theme/speedups.json.
// Needs the gh CLI, logged in. KEY is a group below or a scenario name, STYLE one of:
//   to      "1.2x to 3.4x"     dash    "1.2-3.4", the 10th to 90th percentile
//   median  "10", the rounded median     p90 "14", the rounded 90th percentile, for the headlines
// The percentiles leave out the luckiest and unluckiest runs, the min and max stay for the table.
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
        p10: sorted[sorted.length - Math.ceil(sorted.length * 0.9)],
        p90: sorted[Math.ceil(sorted.length * 0.9) - 1],
        max: sorted[sorted.length - 1],
        runs: values.length
    };
}
/** @type {Record<string, {min: number, p10: number, median: number, p90: number, max: number, runs: number}>} */
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
/** @type {Record<string, (f: {p10: number, median: number, p90: number}) => string>} */
const STYLES = {
    to: (f) => `${one(f.p10)}x to ${one(f.p90)}x`,
    dash: (f) => `${one(f.p10)}-${one(f.p90)}`,
    median: (f) => String(Math.round(f.median)),
    p90: (f) => String(Math.round(f.p90))
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
const headline = Math.round(figures["routing/routes-1000-params"].p90);
await writeFile(
    new URL(".vitepress/theme/speedups.json", import.meta.url),
    JSON.stringify({ period, headline, figures }, null, 4) + "\n"
);
const pkgUrl = new URL("../package.json", import.meta.url);
const pkg = await readFile(pkgUrl, "utf8");
await writeFile(pkgUrl, pkg.replace(/("description": "[^"]*up to )\d+x/, `$1${headline}x`));
for (const name of [...Object.keys(GROUPS), ...Object.keys(medians).sort()]) {
    const f = figures[name];
    console.log(`${name.padEnd(40)} ${one(f.p10)}x to ${one(f.p90)}x, median ${one(f.median)}x over ${f.runs}`);
}
console.log(period);
