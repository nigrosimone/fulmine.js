// npm --prefix integrations test           every case
// npm --prefix integrations test nest      just that one
//
// Each case in cases/ is run twice, once with Express and once with Fulmine, and the two runs have
// to print the same bytes. Same rule as the comparison suite in tests/, and the same reason: a
// framework built on Express is a much larger user of the Express surface than any application is,
// so it reaches parts of it no test written by hand would think to reach.
//
// The two arms never run at the same time. A case binds a fixed port and two µWS servers can hold
// one port at once on Windows, which would have one arm reading the other's answers.

const fs = require("fs");
const path = require("path");
const net = require("node:net");
const test = require("node:test");
const assert = require("node:assert");
const { execFile } = require("node:child_process");
const { ensureBuilt } = require("./build.js");

const CASES_DIR = path.join(__dirname, "cases");
const CASE_TIMEOUT_MS = 120000;
const PORT_WAIT_STEPS = 200;
const PORT_WAIT_MS = 25;
const PORT_IN_SOURCE = /const PORT = (\d{4,5})/g;

// see tests/win-exit-delay.cjs: without it every arm asserts at exit under Node 24+ on Windows
const NODE_ARGS =
    process.platform === "win32" ? ["--require", path.join(__dirname, "..", "tests", "win-exit-delay.cjs")] : [];

/**
 * @param {string} code
 * @returns {number[]} the ports this case listens on
 */
function portsOf(code) {
    return [...new Set([...code.matchAll(PORT_IN_SOURCE)].map((match) => Number(match[1])))];
}

/**
 * @param {number} port
 * @returns {Promise<boolean>} whether anything answers there right now
 */
function portBusy(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        const done = (/** @type {boolean} */ busy) => {
            socket.destroy();
            resolve(busy);
        };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        socket.setTimeout(500, () => done(false));
    });
}

/**
 * Waits until nothing is listening on these ports, so one arm cannot reach the arm before it.
 *
 * @param {number[]} ports
 * @returns {Promise<void>}
 */
async function waitForFreePorts(ports) {
    for (const port of ports) {
        for (let step = 0; step < PORT_WAIT_STEPS; step++) {
            if (!(await portBusy(port))) break;
            await new Promise((resolve) => setTimeout(resolve, PORT_WAIT_MS));
        }
    }
}

/**
 * Runs one case on one arm and hands back everything it wrote.
 *
 * stderr is kept: a case that dies before printing anything would otherwise fail as an empty
 * string against an empty string, which is the one way a comparison can pass by accident.
 *
 * @param {string} file the case
 * @param {"express"|"fulmine"} arm
 * @returns {Promise<string>}
 */
function runArm(file, arm) {
    return new Promise((resolve, reject) => {
        execFile(
            process.execPath,
            [...NODE_ARGS, file],
            {
                cwd: __dirname,
                timeout: CASE_TIMEOUT_MS,
                env: { ...process.env, INTEGRATION_ARM: arm },
                maxBuffer: 32 * 1024 * 1024
            },
            (error, stdout, stderr) => {
                if (error && !stdout) {
                    reject(new Error(`${path.basename(file)} on ${arm}: ${error.message}\n${stderr}`));
                    return;
                }
                resolve(stdout + (stderr ? `\n[stderr]\n${stderr}` : ""));
            }
        );
    });
}

const wanted = process.argv[2];
const cases = fs
    .readdirSync(CASES_DIR)
    .filter((name) => name.endsWith(".js"))
    .filter((name) => !wanted || name.startsWith(wanted));

if (!cases.length) {
    console.error(wanted ? `no case matches ${wanted}` : "no cases in cases/");
    process.exitCode = 1;
}

for (const name of cases) {
    const file = path.join(CASES_DIR, name);
    test(name, { timeout: CASE_TIMEOUT_MS * 2 }, async () => {
        // a case whose name matches an application in apps/ serves what that build produced, so it
        // is built first. Already built and untouched costs a directory walk and nothing else
        ensureBuilt(name.replace(/\.js$/, ""));
        const ports = portsOf(fs.readFileSync(file, "utf8"));
        await waitForFreePorts(ports);
        const expressOutput = await runArm(file, "express");
        await waitForFreePorts(ports);
        const fulmineOutput = await runArm(file, "fulmine");

        if (fulmineOutput !== expressOutput) {
            // written down rather than only diffed in the terminal, because these outputs are long
            // and the interesting line is rarely the first one
            const stem = path.join(__dirname, name.replace(/\.js$/, ""));
            fs.writeFileSync(`${stem}.express.txt`, expressOutput);
            fs.writeFileSync(`${stem}.fulmine.txt`, fulmineOutput);
            console.error(`wrote ${stem}.express.txt and ${stem}.fulmine.txt`);
        }
        assert.strictEqual(fulmineOutput, expressOutput);
    });
}
