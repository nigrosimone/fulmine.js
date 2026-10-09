// Refreshes the HttpArena snapshot charted on the home page: npm run arena --prefix site
// The composite is read from the board the arena renders itself, it is never recomputed here.
import { writeFile } from "node:fs/promises";

const board = "https://www.http-arena.com/";

const [html, data] = await Promise.all([
    fetch(board).then((r) => r.text()),
    fetch(new URL("data.json", board)).then((r) => r.json())
]);

// the board lists tuned entries too, the default view (and the badges) keep only the standard ones
const rows = [];
const cell =
    /<tr><td class="n[^"]*">\d+<\/td><td><a href="\/frameworks\/([^/]+)\/">[^<]*<\/a><\/td><td class="sb-lang">([^<]*)<\/td><td class="n">(\d+)<\/td><\/tr>/g;
for (const [, slug, lang, score] of html.matchAll(cell)) {
    if (data.meta[slug]?.mode === "standard") rows.push({ slug, lang, score: Number(score) });
}
rows.sort((a, b) => b.score - a.score);
rows.forEach((row, i) => (row.rank = i + 1));

const us = rows.find((row) => row.slug === "fulmine.js");
if (rows.length < 50 || !us) throw new Error(`the board changed shape: ${rows.length} rows, fulmine.js ${!!us}`);
const js = rows.filter((row) => row.lang === us.lang);
// the rank in the chart's JavaScript view, which counts TypeScript too
rows.filter((row) => row.lang === "JS" || row.lang === "TS").forEach((row, i) => (row.jsRank = i + 1));

// everyone ahead of us, then only the flagship entries, the names people know; ranks are on the whole board
const snapshot = {
    date: new Date().toISOString().slice(0, 10),
    total: rows.length,
    rank: us.rank,
    jsRank: js.indexOf(us) + 1,
    jsTotal: js.length,
    rows: rows.filter((row) => row.rank <= us.rank || data.meta[row.slug].type === "flagship")
};
await writeFile(new URL(".vitepress/theme/arena.json", import.meta.url), JSON.stringify(snapshot, null, 4) + "\n");
console.log(`fulmine.js #${snapshot.rank} of ${snapshot.total}, #${snapshot.jsRank} of ${snapshot.jsTotal} in JS`);
