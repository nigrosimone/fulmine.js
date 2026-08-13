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
