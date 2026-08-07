"use strict";

// Starting and stopping the scenario servers, shared by run.js and ab.js. It lives here rather
// than in either of them because the handoff between two servers on the same port is subtle
// enough that a second copy would eventually disagree with the first.

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const REPO_ROOT = path.join(__dirname, "..");
// inside the repo on purpose: a worktree in the system temp directory cannot resolve node_modules
const WORKTREE_DIR = path.join(REPO_ROOT, ".ab-worktree");

function git(...gitArgs) {
    return execFileSync("git", gitArgs, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/**
 * Checks a revision out beside the working tree and answers the path to its src/index.js, which is
 * what FULMINE_SRC takes. Detached, so the ref is not checked out anywhere that could then be
 * committed to by mistake.
 */
function addWorktree(ref) {
    removeWorktree();
    git("worktree", "add", "--detach", WORKTREE_DIR, ref);
    return path.join(WORKTREE_DIR, "src", "index.js");
}

function removeWorktree() {
    if (!fs.existsSync(WORKTREE_DIR)) {
        return;
    }
    try {
        git("worktree", "remove", "--force", WORKTREE_DIR);
    } catch {
        fs.rmSync(WORKTREE_DIR, { recursive: true, force: true });
        try {
            git("worktree", "prune");
        } catch {
            // nothing left to prune
        }
    }
}

function startScenarioServer(framework, scenarioName, env, stdio) {
    const serverScript = path.join(__dirname, "server.js");
    const serverArgs = [
        serverScript,
        "--framework",
        framework.id,
        "--scenario",
        scenarioName,
        ...(framework.socketPath ? ["--socket", framework.socketPath] : ["--port", String(framework.port)])
    ];

    const server = spawn(process.execPath, serverArgs, {
        cwd: path.join(__dirname, ".."),
        // profile.js asks for an "ipc" channel, which is how it tells the server to stop profiling
        // and write what it has. Everything else takes the three streams and nothing more.
        stdio: stdio || ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env }
    });

    let stderr = "";
    server.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
    });

    return { server, stderrRef: () => stderr };
}

// The child announces itself on stdout once it is listening. Waiting for that line, rather than
// probing the port, is what makes it impossible to be answered by the previous scenario's server:
// the ports get reused, and a server still draining a load run's keep-alive connections will
// happily answer a readiness probe and then never answer the real request.
function waitForReady(server, framework, scenarioName, timeoutMs = 15000) {
    const expected = `ready:${framework.id}:${scenarioName}:${framework.socketPath ?? framework.port}`;

    return new Promise((resolve, reject) => {
        let stdout = "";

        const finish = (err) => {
            clearTimeout(timer);
            server.stdout.off("data", onData);
            server.off("exit", onExit);
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        };

        const onData = (chunk) => {
            stdout += chunk.toString();
            if (stdout.includes(expected)) {
                finish();
            }
        };

        const onExit = (code, signal) => {
            finish(
                new Error(`${framework.id}/${scenarioName} exited (code ${code}, signal ${signal}) before it was ready`)
            );
        };

        const timer = setTimeout(() => {
            finish(
                new Error(
                    `Timeout waiting for ${framework.id}/${scenarioName} on ` +
                        (framework.socketPath ? `socket ${framework.socketPath}` : `port ${framework.port}`)
                )
            );
        }, timeoutMs);

        server.stdout.on("data", onData);
        server.on("exit", onExit);
    });
}

async function stopScenarioServer(server, stderrRef) {
    if (server.exitCode === null) {
        // waiting for the process to actually go is the point: the ports are reused by whatever
        // starts next, so returning while this one still holds its port is what lets a request
        // land on a server that is halfway through shutting down
        const exited = new Promise((resolve) => server.once("exit", resolve));
        server.kill("SIGTERM");
        // a graceful close waits for the load run's keep-alive connections to drain, which is not
        // quick after a scenario that moved hundreds of megabytes, so give it room before insisting
        const insist = setTimeout(() => server.kill("SIGKILL"), 5000);
        await exited;
        clearTimeout(insist);
    }

    const stderr = stderrRef();
    if (stderr.trim()) {
        process.stderr.write(stderr);
    }
}

module.exports = { startScenarioServer, waitForReady, stopScenarioServer, addWorktree, removeWorktree };
