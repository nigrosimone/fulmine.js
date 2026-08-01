"use strict";

// Starting and stopping the scenario servers, shared by run.js and ab.js. It lives here rather
// than in either of them because the handoff between two servers on the same port is subtle
// enough that a second copy would eventually disagree with the first.

const path = require("path");
const { spawn } = require("child_process");

function startScenarioServer(framework, scenarioName, env) {
    const serverScript = path.join(__dirname, "server.js");
    const serverArgs = [
        serverScript,
        "--framework",
        framework.id,
        "--scenario",
        scenarioName,
        "--port",
        String(framework.port)
    ];

    const server = spawn(process.execPath, serverArgs, {
        cwd: path.join(__dirname, ".."),
        stdio: ["ignore", "pipe", "pipe"],
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
    const expected = `ready:${framework.id}:${scenarioName}:${framework.port}`;

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
            finish(new Error(`Timeout waiting for ${framework.id}/${scenarioName} on port ${framework.port}`));
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

module.exports = { startScenarioServer, waitForReady, stopScenarioServer };
