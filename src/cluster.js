/*
Copyright 2026 Nigro Simone

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// express({ cluster: "auto" }): one process per core, all on the same port.
//
// The usual answer is the cluster module, where the primary holds the listening socket and passes
// each accepted connection to a worker over IPC. uWS does not need that: it binds with the port
// marked shared, which is SO_REUSEPORT, so every worker has its own listening socket on the same
// port and the kernel picks who gets each connection. No primary in the path, nothing serialised.
//
// Application#listen already passes the flag. What was missing is the fork.

"use strict";

const cluster = require("cluster");
const fs = require("fs");
const os = require("os");

/**
 * @param {string} file
 * @returns {string}
 */
function readFile(file) {
    return fs.readFileSync(file, "utf8");
}

/**
 * How many cores the operating system says are usable.
 *
 * @returns {number}
 */
function parallelism() {
    return os.availableParallelism ? os.availableParallelism() : os.cpus().length;
}

/**
 * The CPU quota a cgroup puts on this process, in cores, or undefined where there is none.
 *
 * This is the number that matters in a container: os.availableParallelism() reports the machine,
 * so a 2-core pod on a 64-core node would fork 64 processes. Both cgroup layouts are read, v2 first.
 *
 * @param {(file: string) => string} [read] the file reader, for a test that has no cgroup
 * @returns {number|undefined}
 */
function cgroupCores(read = readFile) {
    try {
        const [quota, period] = read("/sys/fs/cgroup/cpu.max").trim().split(/\s+/);
        // "max" is the word for no quota at all, and it is not a number
        if (quota !== "max" && Number(period) > 0) {
            return Number(quota) / Number(period);
        }
    } catch {
        // no cgroup v2 here, try the older layout
    }
    try {
        const quota = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"));
        const period = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us"));
        if (quota > 0 && period > 0) {
            return quota / period;
        }
    } catch {
        // nor v1: this is a plain machine
    }
    return undefined;
}

/**
 * The cores this process may actually use: what the machine has, capped by what the cgroup allows.
 *
 * @param {(file: string) => string} [read]
 * @param {() => number} [cores]
 * @returns {number}
 */
function availableCores(read = readFile, cores = parallelism) {
    const machine = cores();
    const quota = cgroupCores(read);
    if (quota === undefined || !(quota > 0)) {
        return machine;
    }
    // floored, never rounded up: half a core of headroom is not a process
    return Math.max(1, Math.min(machine, Math.floor(quota)));
}

/**
 * How many workers a `cluster` setting asks for. Zero means the setting is off and the process
 * serves by itself, which is the default.
 *
 * A value nobody can read throws instead of quietly meaning zero: `cluster: "atuo"` would run on
 * one core in production and say nothing about it.
 *
 * @param {boolean|number|"auto"|undefined} setting
 * @param {number} [cores] counted only when the setting asks for it: every application calls this,
 *   and almost none of them wants the cgroup read
 * @returns {number}
 */
function workerCount(setting, cores) {
    if (setting === undefined || setting === false || setting === 0) {
        return 0;
    }
    if (setting === true || setting === "auto") {
        return Math.max(1, cores ?? availableCores());
    }
    if (typeof setting === "number" && Number.isFinite(setting) && setting > 0) {
        return Math.floor(setting);
    }
    throw new TypeError(`cluster must be "auto", a boolean or a positive number, not ${JSON.stringify(setting)}`);
}

// Whether this process forked workers and serves nothing itself. About the process, not the app:
// an entry with a second app on a TLS port would bind that one here and every worker would fail.
let supervising = false;

/**
 * Whether this process forked workers and left the serving to them.
 *
 * @returns {boolean}
 */
function isSupervising() {
    return supervising;
}

/**
 * Says this process is the primary of a clustered application, before it has forked anything.
 *
 * Written when the application is constructed, not when it listens: an entry that listens on its
 * TLS port first would take that port here, exclusively, one line before the fork.
 *
 * @returns {void}
 */
function becomeSupervisor() {
    supervising = true;
}

/**
 * Forks the workers and keeps that many of them alive.
 *
 * A dead worker is replaced and has nothing to rebuild, it binds the shared port again. A signal
 * that reaches only the primary, which is what a container sends, is passed on to the workers.
 *
 * @param {number} count
 * @returns {{stop: () => void}}
 */
function forkWorkers(count) {
    let stopping = false;
    supervising = true;
    /** @param {import("cluster").Worker} worker @param {number} code @param {string} signal */
    const onExit = (worker, code, signal) => {
        if (!stopping) {
            console.error(`worker ${worker.process.pid} exited (${signal || code}), starting another`);
            cluster.fork();
        }
    };
    cluster.on("exit", onExit);
    for (let i = 0; i < count; i++) {
        cluster.fork();
    }
    const stop = () => {
        stopping = true;
        supervising = false;
        cluster.off("exit", onExit);
        for (const id of Object.keys(cluster.workers ?? {})) {
            /** @type {NodeJS.Dict<import("cluster").Worker>} */ (cluster.workers)[id]?.kill();
        }
    };
    for (const signal of ["SIGTERM", "SIGINT"]) {
        process.on(signal, () => {
            stop();
            // the primary exits on its own once the last IPC channel closes, this only makes sure
            // it does. Unref'd, so it never keeps the process up by itself
            const done = setInterval(() => {
                if (Object.keys(cluster.workers ?? {}).length === 0) {
                    clearInterval(done);
                    process.exit(0);
                }
            }, 20);
            done.unref();
        });
    }
    return { stop };
}

module.exports = { availableCores, cgroupCores, workerCount, forkWorkers, isSupervising, becomeSupervisor };
