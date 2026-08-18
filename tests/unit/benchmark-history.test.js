// What the benchmark says moved between two runs. None of this touches a server, and all of it
// decides whether a summary reports a regression, so it is worth pinning: a comparison that reads
// a failed arm as a zero ratio, or that compares two runs no reader would consider comparable,
// makes the whole section worse than not having one.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    machineKey,
    looseKey,
    readHistory,
    runRecordOf,
    baselineFor,
    appendRun,
    compareRuns,
    historyMarkdown,
    NOTABLE
} = require("../../benchmark/history.js");

function row(name, express, fulmine, { expressOk = true, fulmineOk = true } = {}) {
    return {
        name,
        express: { ok: expressOk, requestsPerSec: express },
        ultimate: { ok: fulmineOk, requestsPerSec: fulmine }
    };
}

function runOf(scenarios, at, commit) {
    return { at, commit, node: process.versions.node, scenarios };
}

test("the exact key extends the loose one, so a loose match can be found by prefix", () => {
    assert.ok(machineKey().startsWith(`${looseKey()}-`));
    // the major node version is in both: a ratio that moved because node:http got faster is not a
    // regression here, and has been read as one before
    assert.ok(looseKey().includes(`node${process.versions.node.split(".")[0]}`));
});

test("a run records the ratio, and records nothing for a scenario an arm failed", () => {
    const record = runRecordOf([
        row("plain/hello", 10000, 25000),
        row("static/file", 5000, 5000),
        row("broken/express", 8000, 16000, { expressOk: false }),
        row("broken/fulmine", 8000, 16000, { fulmineOk: false }),
        row("broken/zero", 0, 16000)
    ]);

    assert.deepStrictEqual(Object.keys(record.scenarios).sort(), ["plain/hello", "static/file"]);
    assert.strictEqual(record.scenarios["plain/hello"].speedup, 2.5);
    assert.strictEqual(record.scenarios["plain/hello"].express, 10000);
    assert.strictEqual(record.scenarios["plain/hello"].fulmine, 25000);
    assert.strictEqual(record.scenarios["static/file"].speedup, 1);
});

test("only a move past the noise floor is marked, in either direction", () => {
    const before = runOf({
        steady: { speedup: 2, express: 100, fulmine: 200 },
        faster: { speedup: 2, express: 100, fulmine: 200 },
        slower: { speedup: 2, express: 100, fulmine: 200 },
        gone: { speedup: 2, express: 100, fulmine: 200 }
    });
    const after = runOf({
        steady: { speedup: 2 * (1 + NOTABLE / 2), express: 100, fulmine: 210 },
        faster: { speedup: 2 * (1 + NOTABLE * 2), express: 100, fulmine: 240 },
        slower: { speedup: 2 * (1 - NOTABLE * 2), express: 100, fulmine: 160 },
        fresh: { speedup: 3, express: 100, fulmine: 300 }
    });

    const { rows, added, missing } = compareRuns(before, after);
    const marked = Object.fromEntries(rows.map((entry) => [entry.name, entry.notable]));

    assert.strictEqual(marked.steady, false);
    assert.strictEqual(marked.faster, true);
    assert.strictEqual(marked.slower, true);
    // the biggest movement first, since that is the only reason to read the section
    assert.ok(Math.abs(rows[0].change) >= Math.abs(rows[rows.length - 1].change));
    assert.deepStrictEqual(added, ["fresh"]);
    assert.deepStrictEqual(missing, ["gone"]);
});

test("the baseline is this machine when there is one, and the most recent same-shape one otherwise", () => {
    const exact = "linux-x64-4c-node26-amd-epyc";
    const loose = "linux-x64-4c-node26";
    const other = "linux-x64-4c-node26-intel-xeon";
    const older = "linux-x64-4c-node26-intel-xeon-older";
    const elsewhere = "linux-x64-8c-node26-amd-epyc";

    const history = {
        [other]: [runOf({}, "2026-08-01T00:00:00.000Z", "aaaaaaa")],
        [older]: [runOf({}, "2026-08-05T00:00:00.000Z", "bbbbbbb")],
        [elsewhere]: [runOf({}, "2026-08-06T00:00:00.000Z", "ccccccc")]
    };

    // no run on this cpu yet: the most recent one on a machine of the same shape, and not the one
    // with eight cores, whose key only looks similar
    const fallback = baselineFor(history, exact, loose);
    assert.strictEqual(fallback.exact, false);
    assert.strictEqual(fallback.run.commit, "bbbbbbb");

    history[exact] = [runOf({}, "2026-07-01T00:00:00.000Z", "ddddddd")];
    const here = baselineFor(history, exact, loose);
    // an older run on this cpu beats a newer one on another: same-machine is the stronger comparison
    assert.strictEqual(here.exact, true);
    assert.strictEqual(here.run.commit, "ddddddd");

    assert.strictEqual(baselineFor({}, exact, loose), null);
});

test("the section is absent without a baseline, and says so when the baseline is another cpu", () => {
    const current = runOf({ plain: { speedup: 2.2, express: 100, fulmine: 220 } });
    const previous = runOf(
        { plain: { speedup: 2, express: 100, fulmine: 200 } },
        "2026-08-01T10:00:00.000Z",
        "aaaaaaa"
    );

    assert.strictEqual(historyMarkdown(null, current), null);
    // a baseline that shares no scenario with this run compares nothing, so it prints nothing
    assert.strictEqual(
        historyMarkdown({ run: runOf({ other: { speedup: 1 } }), exact: true, key: "k" }, current),
        null
    );

    const exact = historyMarkdown({ run: previous, exact: true, key: "k" }, current);
    assert.match(exact, /Against the last run on this machine/);
    assert.match(exact, /`aaaaaaa`/);
    assert.match(exact, /\+10\.0%/);
    assert.doesNotMatch(exact, /different cpu/);
    // 10% is the noise floor exactly, so this row is marked, and a rise is marked as a rise
    assert.match(exact, /\| plain :trophy: \|/);
    assert.doesNotMatch(exact, /plain :eyes:/);

    const loose = historyMarkdown({ run: previous, exact: false, key: "linux-x64-4c-node26-something" }, current);
    assert.match(loose, /a machine of the same shape/);
    assert.match(loose, /different cpu/);
});

test("history survives a missing file, and keeps a bounded number of runs per machine", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-history-")), "benchmark_history.json");
    const key = "linux-x64-4c-node26-cpu";

    // a first run, or an artifact that expired, is not a reason to fail a benchmark
    assert.deepStrictEqual(readHistory(file), {});
    fs.writeFileSync(file, "not json at all", "utf8");
    assert.deepStrictEqual(readHistory(file), {});

    let history = {};
    for (let index = 0; index < 25; index++) {
        appendRun(
            file,
            history,
            key,
            runOf({}, `2026-08-01T00:00:${String(index).padStart(2, "0")}.000Z`, `c${index}`)
        );
        history = readHistory(file);
    }

    assert.strictEqual(history[key].length, 20);
    assert.strictEqual(history[key][0].commit, "c5");
    assert.strictEqual(history[key][19].commit, "c24");

    fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("a ratio that fell is marked for a look, one that rose is marked as a win", () => {
    const previous = runOf({
        fell: { speedup: 2, express: 100, fulmine: 200 },
        rose: { speedup: 2, express: 100, fulmine: 200 },
        weather: { speedup: 2, express: 100, fulmine: 200 }
    });
    const current = runOf({
        fell: { speedup: 1.7, express: 100, fulmine: 170 },
        rose: { speedup: 2.4, express: 100, fulmine: 240 },
        weather: { speedup: 2.1, express: 100, fulmine: 210 }
    });

    const out = historyMarkdown({ run: previous, exact: true, key: "k" }, current);
    assert.match(out, /\| fell :eyes: \|/);
    assert.match(out, /\| rose :trophy: \|/);
    // under the noise floor, so neither: a table of a dozen ratios always has one of these
    assert.match(out, /\| weather \|/);
});

test("with a window, a move the recent runs have already seen is not marked", () => {
    // five runs that wandered between 1.8 and 2.3 on the same code: that band is this row's own
    // weather, and a sixth run inside it is not news however far it sits from the fifth
    const wander = [1.8, 2.3, 2.0, 2.2, 1.9];
    const windowRuns = wander.map((speedup, index) =>
        runOf({ jumpy: { speedup, express: 100, fulmine: speedup * 100 } }, `2026-08-0${index + 1}T00:00:00.000Z`)
    );
    const previous = windowRuns[windowRuns.length - 1];

    // +15.8% against the last run, and inside the band: the flat floor used to flag this
    const inside = runOf({ jumpy: { speedup: 2.2, express: 100, fulmine: 220 } });
    let { rows } = compareRuns(previous, inside, windowRuns);
    assert.strictEqual(rows[0].notable, false);

    // outside the band and past the floor from the median: real news
    const outside = runOf({ jumpy: { speedup: 2.6, express: 100, fulmine: 260 } });
    ({ rows } = compareRuns(previous, outside, windowRuns));
    assert.strictEqual(rows[0].notable, true);

    // outside the band but within the floor of the median: a band this tight proves nothing
    const tightWindow = [2.0, 2.01, 2.02].map((speedup, index) =>
        runOf({ jumpy: { speedup, express: 100, fulmine: speedup * 100 } }, `2026-08-0${index + 1}T00:00:00.000Z`)
    );
    const nudge = runOf({ jumpy: { speedup: 2.1, express: 100, fulmine: 210 } });
    ({ rows } = compareRuns(tightWindow[2], nudge, tightWindow));
    assert.strictEqual(rows[0].notable, false);
});

function steadyWindow(names, speedup = 2) {
    return Array.from({ length: 5 }, (unused, index) =>
        runOf(
            Object.fromEntries(names.map((name) => [name, { speedup, express: 100, fulmine: speedup * 100 }])),
            `2026-08-0${index + 1}T00:00:00.000Z`
        )
    );
}

test("a small shift the whole table shares is divided out before any row is judged", () => {
    // the recorded 5f5fc98 shape: a table median a few percent down because the runner's session
    // capped the fast arm lower, two rows reading -11% raw that the shift explains, and one row
    // that moved further than the table did. Only the last one is news.
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
    const windowRuns = steadyWindow(names);
    const scenarios = Object.fromEntries(names.map((name) => [name, { speedup: 1.92, express: 100, fulmine: 192 }]));
    scenarios.j = { speedup: 1.78, express: 100, fulmine: 178 };
    scenarios.k = { speedup: 1.78, express: 100, fulmine: 178 };
    scenarios.l = { speedup: 1.5, express: 100, fulmine: 150 };

    const { rows, shift } = compareRuns(windowRuns[4], runOf(scenarios), windowRuns);
    const marked = Object.fromEntries(rows.map((entry) => [entry.name, entry.notable]));

    assert.ok(Math.abs(shift - 0.96) < 1e-9);
    // -11% raw, -7% once the table's own -4% is divided out: the flat floor used to flag these
    assert.strictEqual(marked.j, false);
    assert.strictEqual(marked.k, false);
    assert.strictEqual(marked.l, true);
});

test("a table-wide move past the floor is not divided out, it could be the code", () => {
    // every scenario down 30% at once: a change on a path every request pays has exactly this
    // shape, so nothing is divided, every row flags, and the section says an A/B must decide
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const windowRuns = steadyWindow(names);
    const scenarios = Object.fromEntries(names.map((name) => [name, { speedup: 1.4, express: 100, fulmine: 140 }]));

    const { rows, shift, tableMove } = compareRuns(windowRuns[4], runOf(scenarios), windowRuns);
    assert.strictEqual(shift, 1);
    assert.ok(Math.abs(tableMove - 0.7) < 1e-9);
    for (const entry of rows) {
        assert.strictEqual(entry.notable, true);
    }

    const out = historyMarkdown({ run: windowRuns[4], runs: windowRuns, exact: true, key: "k" }, runOf(scenarios));
    assert.match(out, /cannot tell them apart/);
});

test("a row seen in a single window run is judged by the flat floor, not by the shift", () => {
    // ten rows carry a -9.5% session shift; one scenario exists only in the previous run and did
    // not move at all. Dividing it by the shift would read the unmoved row as +10% and flag it.
    const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const windowRuns = steadyWindow(names);
    windowRuns[4].scenarios.fresh = { speedup: 2, express: 100, fulmine: 200 };
    const scenarios = Object.fromEntries(names.map((name) => [name, { speedup: 1.81, express: 100, fulmine: 181 }]));
    scenarios.fresh = { speedup: 2, express: 100, fulmine: 200 };

    const { rows } = compareRuns(windowRuns[4], runOf(scenarios), windowRuns);
    const marked = Object.fromEntries(rows.map((entry) => [entry.name, entry.notable]));
    assert.strictEqual(marked.fresh, false);
    assert.strictEqual(marked.a, false);
});

test("the record keeps the round median and its spread when the run measured in rounds", () => {
    // the median of the rounds is not the quotient of the two averages, and the spread is what
    // lets a later reader tell a stable measurement from one that straddled two levels
    const record = runRecordOf([{ ...row("paired", 100, 200), speedup: 2.1, roundRatios: [1.9, 2.1, 2.3] }]);
    assert.strictEqual(record.scenarios.paired.speedup, 2.1);
    assert.deepStrictEqual(record.scenarios.paired.spread, [1.9, 2.3]);
});

test("a bound row is never marked, its ratio cannot really move", () => {
    const previous = runOf({ ceiling: { speedup: 1.09, express: 1000, fulmine: 1090, bound: true } });
    const current = runOf({ ceiling: { speedup: 0.92, express: 1000, fulmine: 920, bound: true } });

    const { rows } = compareRuns(previous, current);
    assert.strictEqual(rows[0].notable, false);
    assert.strictEqual(rows[0].bound, true);
});

test("the record carries the bound mark, and the baseline carries the recent window", () => {
    const record = runRecordOf([
        { ...row("free", 100, 200) },
        { ...row("capped", 1000, 1020), bound: { by: "utf8+JSON.parse", ceiling: 1.02 } }
    ]);
    assert.strictEqual(record.scenarios.free.bound, undefined);
    assert.strictEqual(record.scenarios.capped.bound, true);

    const key = "linux-x64-4c-node26-cpu";
    const history = {
        [key]: Array.from({ length: 8 }, (unused, index) =>
            runOf({}, `2026-08-0${index + 1}T00:00:00.000Z`, `c${index}`)
        )
    };
    const baseline = baselineFor(history, key, "linux-x64-4c-node26");
    // the window is the tail of the kept runs, and the run column stays the very last one
    assert.strictEqual(baseline.runs.length, 5);
    assert.strictEqual(baseline.runs[4], baseline.run);
});
