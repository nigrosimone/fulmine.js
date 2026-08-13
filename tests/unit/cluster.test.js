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

test("what each setting asks for", () => {
    assert.strictEqual(workerCount(undefined), 0, "off by default");
    assert.strictEqual(workerCount(false), 0);
    assert.strictEqual(workerCount(0), 0);
    assert.strictEqual(workerCount("auto", 8), 8);
    assert.strictEqual(workerCount(true, 8), 8);
    assert.strictEqual(workerCount(3, 8), 3, "a number is taken as written, cores or no cores");
    assert.strictEqual(workerCount("auto", 0), 1, "a machine that reports nothing still runs one");
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
