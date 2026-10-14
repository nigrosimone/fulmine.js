// express({ cluster }): the count, and then two real processes on one port.
//
// The count is the part that is easy to get wrong somewhere nobody looks, so it is read from an
// injected cgroup rather than from this machine: a 2-core pod on a 64-core node has to answer 2.
// The fork is the part that is easy to believe without checking, so there is one test that starts
// an application with two workers and asks it which process answered.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { fork } = require("node:child_process");
const { availableCores, cgroupCores, workerCount } = require("../../src/cluster.js");

/**
 * A cgroup that is not this machine's.
 *
 * @param {Record<string, string>} files
 * @returns {(file: string) => string}
 */
function cgroup(files) {
    return (file) => {
        if (files[file] === undefined) {
            throw new Error("ENOENT " + file);
        }
        return files[file];
    };
}

test("a cgroup v2 quota is read in cores", () => {
    assert.strictEqual(cgroupCores(cgroup({ "/sys/fs/cgroup/cpu.max": "200000 100000\n" })), 2);
    assert.strictEqual(cgroupCores(cgroup({ "/sys/fs/cgroup/cpu.max": "150000 100000\n" })), 1.5);
    // "max" is the word for no quota, and Number("max") is NaN
    assert.strictEqual(cgroupCores(cgroup({ "/sys/fs/cgroup/cpu.max": "max 100000\n" })), undefined);
});

test("a cgroup v1 quota is read too, and a machine without either says nothing", () => {
    const v1 = cgroup({
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "400000\n",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n"
    });
    assert.strictEqual(cgroupCores(v1), 4);
    // -1 is how v1 spells no quota
    const none = cgroup({
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n"
    });
    assert.strictEqual(cgroupCores(none), undefined);
    assert.strictEqual(cgroupCores(cgroup({})), undefined);
});

test("the quota caps the machine, and never rounds a fraction up into a process", () => {
    const machine = () => 64;
    assert.strictEqual(availableCores(cgroup({ "/sys/fs/cgroup/cpu.max": "200000 100000" }), machine), 2);
    assert.strictEqual(availableCores(cgroup({ "/sys/fs/cgroup/cpu.max": "150000 100000" }), machine), 1);
    assert.strictEqual(
        availableCores(cgroup({ "/sys/fs/cgroup/cpu.max": "50000 100000" }), machine),
        1,
        "half a core still runs"
    );
    assert.strictEqual(availableCores(cgroup({}), machine), 64, "no cgroup, no cap");
    // a quota wider than the machine is not more processes than there are cores
    assert.strictEqual(availableCores(cgroup({ "/sys/fs/cgroup/cpu.max": "12800000 100000" }), machine), 64);
});

test("and this machine answers something it could actually fork", () => {
    // the one call with nothing injected: whatever it reads here, a worker count has to come out
    const here = availableCores();
    assert.ok(Number.isInteger(here) && here >= 1, `not a number of processes: ${here}`);
    assert.strictEqual(workerCount("auto"), here > 1 ? here : 0);
});

test("what each setting asks for", () => {
    assert.strictEqual(workerCount(undefined), 0, "off by default");
    assert.strictEqual(workerCount(false), 0);
    assert.strictEqual(workerCount(0), 0);
    assert.strictEqual(workerCount("auto", 8), 8);
    assert.strictEqual(workerCount(true, 8), 8);
    // one core serves from the one process, a number asks for its forks anyway
    assert.strictEqual(workerCount("auto", 1), 0);
    assert.strictEqual(workerCount(true, 1), 0);
    assert.strictEqual(workerCount(1, 1), 1);
    assert.strictEqual(workerCount(3, 8), 3, "a number is taken as written, cores or no cores");
    assert.strictEqual(workerCount("auto", 0), 0, "a machine that reports nothing serves from the one process");
});

test("a setting nobody can read is a throw and not a quiet single core", () => {
    assert.throws(() => workerCount("atuo"), /cluster must be "auto"/);
    assert.throws(() => workerCount(-2), /positive number/);
    assert.throws(() => workerCount(Infinity), /positive number/);
});

// The real thing: an application with two workers, and no primary in the path.

const PORT = 13411;
const script = path.join(os.tmpdir(), `fulmine-cluster-${process.pid}.js`);
const entry = path.join(__dirname, "../../src/index.js").split(path.sep).join("/");

fs.writeFileSync(
    script,
    `const cluster = require("cluster");
const express = require(${JSON.stringify(entry)});
const app = express({ cluster: 2 });
app.get("/who", (req, res) => res.send(String(process.pid)));
// a second app, the shape an entry with a TLS port has, and without a cluster setting of its own:
// the primary must not bind this one either, or no worker could
const other = express();
other.get("/who", (req, res) => res.send(String(process.pid)));
other.listen(${PORT + 1});
if (cluster.isPrimary) {
    // a worker's process.send goes to its primary, so the primary is the one that can answer the
    // test: it passes on what the workers say and stops them when asked
    cluster.on("message", (worker, message) => process.send(message));
    process.on("message", (message) => {
        if (message === "stop") app.close(() => process.exit(0));
    });
}
app.listen(${PORT}, () => process.send("up"));
`
);

/**
 * @param {string} target
 * @param {number} [port]
 * @returns {Promise<string>}
 */
function get(target, port = PORT) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${target}`, (res) => {
            let text = "";
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () => resolve(text));
        }).on("error", reject);
    });
}

test("two workers share one port, and neither of them is the process that forked", { timeout: 60000 }, async (t) => {
    const child = fork(script, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    t.after(() => {
        child.kill();
        fs.rmSync(script, { force: true });
    });

    // the workers report through the primary's channel, one message each
    await new Promise((resolve, reject) => {
        let up = 0;
        child.on("message", (message) => {
            if (message === "up" && ++up === 2) resolve(undefined);
        });
        child.on("exit", (code) => reject(new Error("the app exited with " + code)));
        setTimeout(() => reject(new Error("no worker came up")), 30000).unref();
    });

    /** @type {Set<string>} */
    const pids = new Set();
    for (let i = 0; i < 20; i++) {
        pids.add(await get("/who"));
    }
    assert.ok(pids.size >= 1, "somebody answered");
    assert.ok(!pids.has(String(child.pid)), "and it was a worker, not the primary that forked them");

    // the second app is served by the workers as well: had the primary taken that port for itself,
    // exclusively, the workers would have died on it instead
    const second = await get("/who", PORT + 1);
    assert.notStrictEqual(second, String(child.pid), "the primary serves nothing, whichever app it is");

    // closing the primary takes the workers with it, which is the shutdown a container asks for
    child.send("stop");
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.strictEqual(code, 0);
    await assert.rejects(() => get("/who"), "and the port is free again");
});

test("share() splits a total so the workers add up to it, the first ones taking the remainder", () => {
    const { shareOf } = require("../../src/cluster.js");
    for (const [total, workers] of [
        [40, 6],
        [40, 8],
        [7, 3],
        [3, 8],
        [0, 4]
    ]) {
        const shares = Array.from({ length: workers }, (_, index) => shareOf(total, workers, index));
        assert.strictEqual(
            shares.reduce((a, b) => a + b, 0),
            total,
            `${total} over ${workers}`
        );
        assert.ok(Math.max(...shares) - Math.min(...shares) <= 1, "and evenly");
    }
    assert.deepStrictEqual(
        [0, 1, 2, 3, 4, 5].map((i) => shareOf(40, 6, i)),
        [7, 7, 7, 7, 6, 6]
    );
    assert.strictEqual(shareOf(40, 6, undefined), 0, "the primary serves nothing");
    assert.throws(() => shareOf(-1, 2, 0), /whole number/);
    assert.throws(() => shareOf(2.5, 2, 0), /whole number/);
});

// Each worker knows its place, and one that dies is replaced in the same place.

const PLACE_PORT = 13421;
const placeScript = path.join(os.tmpdir(), `fulmine-cluster-place-${process.pid}.js`);
const marker = path.join(os.tmpdir(), `fulmine-cluster-place-${process.pid}.died`);

fs.writeFileSync(
    placeScript,
    `const cluster = require("cluster");
const fs = require("fs");
const express = require(${JSON.stringify(entry)});
const app = express({ cluster: 3 });
if (cluster.isPrimary) {
    cluster.on("message", (worker, message) => process.send(message));
    process.send({ primary: { workers: app.cluster.workers, index: app.cluster.index ?? null, serves: app.cluster.serves, share: app.cluster.share(10) } });
    process.on("message", (message) => {
        if (message === "stop") app.close(() => process.exit(0));
    });
}
app.listen(${PLACE_PORT}, () => {
    const { workers, index, serves } = app.cluster;
    process.send({ worker: { workers, index, serves, share: app.cluster.share(10), pid: process.pid } });
    // worker 1 dies once, to be replaced
    if (index === 1 && !fs.existsSync(${JSON.stringify(marker)})) {
        fs.writeFileSync(${JSON.stringify(marker)}, "");
        setTimeout(() => process.exit(1), 50);
    }
});
`
);

test(
    "each worker knows how many there are and its own index, kept by its replacement",
    { timeout: 60000 },
    async (t) => {
        const child = fork(placeScript, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
        t.after(() => {
            child.kill();
            fs.rmSync(placeScript, { force: true });
            fs.rmSync(marker, { force: true });
        });
        /** @type {any} */
        let primary;
        /** @type {any[]} */
        const reports = [];
        await new Promise((resolve, reject) => {
            child.on("message", (/** @type {any} */ message) => {
                if (message.primary) primary = message.primary;
                if (message.worker) reports.push(message.worker);
                // three workers, then the replacement of the one that died
                if (reports.length === 4) resolve(undefined);
            });
            child.on("exit", (code) => reject(new Error("the app exited with " + code)));
            setTimeout(() => reject(new Error(`only ${reports.length} workers reported`)), 30000).unref();
        });

        // null for undefined, which the IPC channel drops
        assert.deepStrictEqual(primary, { workers: 3, index: null, serves: false, share: 0 });
        const first = reports.slice(0, 3).sort((a, b) => a.index - b.index);
        assert.deepStrictEqual(
            first.map(({ workers, index, serves, share }) => ({ workers, index, serves, share })),
            [
                { workers: 3, index: 0, serves: true, share: 4 },
                { workers: 3, index: 1, serves: true, share: 3 },
                { workers: 3, index: 2, serves: true, share: 3 }
            ]
        );
        const replacement = reports[3];
        assert.strictEqual(replacement.index, 1, "the replacement takes the place of the worker that died");
        assert.notStrictEqual(replacement.pid, first[1].pid, "and it is a new process");

        child.send("stop");
        assert.strictEqual(await new Promise((resolve) => child.on("exit", resolve)), 0);
    }
);

test("without a cluster the one process serves, as worker 0 of 1 with the whole total", () => {
    const express = require("../../src/index.js");
    const { workers, index, serves } = express().cluster;
    assert.deepStrictEqual(
        { workers, index, serves, share: express().cluster.share(40) },
        { workers: 1, index: 0, serves: true, share: 40 }
    );
});
