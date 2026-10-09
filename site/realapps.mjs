// Refreshes the snapshot of real applications charted on the site: npm run realapps --prefix site
// It reads results/summary.json of nigrosimone/fulmine-compat, which that repository's bench/cost.mjs
// writes from its runs, so nothing is measured or recomputed here. A path in place of the URL reads a
// local checkout instead.
import { readFile, writeFile } from "node:fs/promises";

const from =
    process.argv[2] || "https://raw.githubusercontent.com/nigrosimone/fulmine-compat/main/results/summary.json";
const summary = from.startsWith("http")
    ? await fetch(from).then((r) => {
          if (!r.ok) throw new Error(`${from}: ${r.status}`);
          return r.json();
      })
    : JSON.parse(await readFile(from, "utf8"));

const users = "1000000";
const snapshot = {
    date: summary.date,
    prices: summary.prices,
    projects: summary.projects.map((p) => {
        if (!p.day.express || !p.day.fulmine || !p.year[users]) throw new Error(`${p.name}: the summary changed shape`);
        return {
            name: p.name,
            title: p.title,
            express: p.express,
            fulmine: p.fulmine,
            day: p.day,
            endpoints: p.endpoints,
            // the largest difference Express made against a second Express: below it, nothing is a result
            noise: Math.max(...(p.noise || [0])),
            year: p.year[users]
        };
    })
};
await writeFile(new URL(".vitepress/theme/realapps.json", import.meta.url), JSON.stringify(snapshot, null, 4) + "\n");
for (const p of snapshot.projects) {
    const less = (arm) => Math.round((1 - p.day[arm].cpuMs / p.day.express.cpuMs) * 100);
    console.log(`${p.name}: ${less("fulmine")}% less CPU, ${less("fulmine + patch")}% with the patch`);
}
