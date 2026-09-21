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

"use strict";

// The checks a commit has to pass, the list under "Before you commit" in CONTRIBUTING.md, run one
// after the other and summed up at the end: one line per gate saying green, red or not run. A red
// gate does not stop the ones after it, so one run says everything there is to say.
//
//   node tools/gates.js
//   node tools/gates.js --skip express     # all but that one, said as not run in the summary

const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// in the order of CONTRIBUTING.md, the long one first so its result is not the last thing waited for
const GATES = [
    { name: "test", args: ["test"] },
    { name: "unit", args: ["run", "test:unit"] },
    // --ci is what makes Express's suite a gate; without it the exit status says nothing
    { name: "express", args: ["run", "test:express", "--", "--ci"] },
    { name: "typecheck", args: ["run", "typecheck"] },
    { name: "lint", args: ["run", "lint"] },
    { name: "format", args: ["run", "format:check"] }
];

const skipped = new Set();
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--skip" && process.argv[i + 1]) {
        skipped.add(process.argv[++i]);
    }
}
for (const name of skipped) {
    if (!GATES.some((gate) => gate.name === name)) {
        console.error(`no gate named ${name}, they are: ${GATES.map((gate) => gate.name).join(", ")}`);
        process.exit(2);
    }
}

// npm is a batch file on Windows, and node refuses to spawn one directly since the argument
// injection fix. Through the command interpreter, the way node's own shell option does it
function spawnable(command, args) {
    if (process.platform === "win32" && command === "npm") {
        return [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command, ...args]];
    }
    return [command, args];
}

/** @type {{name: string, result: string, seconds: number}[]} */
const results = [];

for (const gate of GATES) {
    if (skipped.has(gate.name)) {
        results.push({ name: gate.name, result: "not run", seconds: 0 });
        continue;
    }
    process.stdout.write(`\n=== ${gate.name}: npm ${gate.args.join(" ")}\n\n`);
    const started = Date.now();
    const [file, argv] = spawnable("npm", gate.args);
    const run = spawnSync(file, argv, { cwd: ROOT, stdio: "inherit" });
    const seconds = (Date.now() - started) / 1000;
    const result = run.error
        ? `could not start: ${run.error.message}`
        : run.status === 0
          ? "green"
          : `red, exit ${run.status}`;
    results.push({ name: gate.name, result, seconds });
}

const width = Math.max(...results.map((entry) => entry.name.length));
process.stdout.write("\n=== gates\n\n");
for (const entry of results) {
    const time = entry.seconds ? ` (${Math.round(entry.seconds)}s)` : "";
    process.stdout.write(`${entry.name.padEnd(width)}  ${entry.result}${time}\n`);
}
process.stdout.write("\n");

process.exit(results.every((entry) => entry.result === "green" || entry.result === "not run") ? 0 : 1);
