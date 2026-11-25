// Writes the shields.io endpoint badges for the-benchmarker/web-frameworks into the built site:
// npm run benchmarker --prefix site, after the build. The rank is among the entries of our spec
// only, v1 and v2 run different workloads, sorted as the results page sorts by default.
import { mkdir, writeFile } from "node:fs/promises";

const source = "https://raw.githubusercontent.com/the-benchmarker/web-frameworks/master/data.min.json";
const board = "https://web-frameworks-benchmark.vercel.app/result";
const LEVEL = 64;
const ENTRIES = { "fulmine.js": "web-frameworks.json" };

const data = await fetch(source).then((r) => {
    if (!r.ok) throw new Error(`${source} answered ${r.status}`);
    return r.json();
});

const rps = new Map();
for (const m of data.metrics) {
    if (m.level === LEVEL && m.label === "total_requests_per_s") rps.set(m.framework_id, m.value);
}

const out = new URL(".vitepress/dist/badge/", import.meta.url);
await mkdir(out, { recursive: true });

for (const [label, file] of Object.entries(ENTRIES)) {
    const us = data.frameworks.find((f) => f.label === label);
    // the specs field is written since web-frameworks#10447, older data cannot be ranked by spec
    if (!us?.specs || !rps.get(us.id)) throw new Error(`${label}: no specs or no result in the data`);
    const rows = data.frameworks
        .filter((f) => f.specs === us.specs && rps.get(f.id))
        .sort((a, b) => rps.get(b.id) - rps.get(a.id));
    const rank = rows.indexOf(us) + 1;
    const badge = {
        schemaVersion: 1,
        label: `web-frameworks ${us.specs}`,
        message: `#${rank} of ${rows.length}`,
        color: rank === 1 ? "brightgreen" : rank <= 3 ? "green" : "blue"
    };
    await writeFile(new URL(file, out), JSON.stringify(badge) + "\n");
    console.log(`${label}: #${rank} of ${rows.length} on ${us.specs}, ${board}?spec=${us.specs}`);
}
