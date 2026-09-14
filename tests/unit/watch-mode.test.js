// node --watch server.js, which is how a server is run while it is being written.
//
// Watch mode makes every worker thread report the files it loaded to the main thread, on the same
// message channel the file-reading workers answer on, as {"watch:import": [...]}. Read as one of
// our answers it has no task to settle, and the process died on the first request. The script is
// run under --watch for real, so the message is node's own and not one made up here.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = `
const express = require(${JSON.stringify(path.join(__dirname, "../../src/index.js"))});
const app = express({ threads: 1 });
app.get("/", (req, res) => res.send("hello"));
app.listen(0, async () => {
    const response = await fetch("http://localhost:" + app.address().port + "/");
    console.log("answered " + (await response.text()));
    process.exit(0);
});
`;

test("a server started with node --watch answers, and the watch traffic on the worker channel is left alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fulmine-watch-"));
    const file = path.join(dir, "server.js");
    fs.writeFileSync(file, SERVER);

    const child = spawn(process.execPath, ["--watch", file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));

    // watch mode keeps the parent alive after the script exits, so what ends this is the output
    await new Promise((resolve) => {
        const timer = setTimeout(resolve, 15000);
        const poll = setInterval(() => {
            if (/answered hello|TypeError|Failed running/.test(out)) {
                clearTimeout(timer);
                clearInterval(poll);
                resolve(undefined);
            }
        }, 50);
    });
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });

    assert.match(out, /answered hello/, out);
    assert.doesNotMatch(out, /TypeError/, out);
});
