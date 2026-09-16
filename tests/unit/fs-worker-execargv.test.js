// The file worker must not inherit the parent's execArgv. Angular's build extracts routes inside a
// worker started with --import of a loader that reads workerData, our worker is a child of that one,
// and a flag written for the parent throws at the child's startup. Reproduced as a --require on the
// process, which a worker inherits the same way.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("the file worker starts without the parent's --require", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-execargv-"));
    const hook = path.join(dir, "hook.cjs");
    const script = path.join(dir, "app.cjs");
    // what @angular/build's register-hooks.js does with workerData, which is undefined in a thread
    // it was not written for
    fs.writeFileSync(
        hook,
        'const { isMainThread } = require("node:worker_threads");\n' +
            "if (!isMainThread) throw new TypeError(\"Cannot read properties of undefined (reading 'workspaceRoot')\");\n"
    );
    fs.writeFileSync(
        script,
        `
        const express = require(${JSON.stringify(path.join(__dirname, "..", "..", "src", "index.js"))});
        const app = express();
        // the worker is unref'd, so something has to hold the process open for the answer
        const keep = setInterval(() => {}, 1000);
        app.readFileWithWorker(${JSON.stringify(hook)}).then((data) => {
            process.stdout.write(String(data.length));
        }, (err) => { process.stderr.write(String(err)); process.exitCode = 2; }).finally(() => clearInterval(keep));
    `
    );
    const result = spawnSync(process.execPath, ["--require", hook, script], { encoding: "utf8", cwd: dir });
    const size = fs.statSync(hook).size;
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, String(size));
});
