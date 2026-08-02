"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const KB = 1024;
const MB = 1024 * KB;
const STREAM_SIZE_BYTES = 5 * MB;
const STREAM_CHUNK_SIZE = 64 * KB;
const STREAM_CHUNK = Buffer.alloc(STREAM_CHUNK_SIZE, "x");

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        const value = argv[i];
        if (!value.startsWith("--")) {
            continue;
        }
        const key = value.slice(2);
        args[key] = argv[i + 1];
        i++;
    }
    return args;
}

function resolveFramework(frameworkName) {
    if (frameworkName === "express") {
        return require("express");
    }

    if (frameworkName === "fulmine") {
        // ab.js points this at a git worktree so two revisions can be measured against each other.
        // The worktree lives inside the repo, so requires from it still resolve node_modules here.
        return require(process.env.FULMINE_SRC || "../src/index");
    }

    throw new Error(`Unknown framework: ${frameworkName}`);
}

function createContext() {
    const assetsDir = path.join(__dirname, "assets");
    const viewsDir = path.join(__dirname, "views");
    const staticFilePath = path.join(assetsDir, "static-250kb.txt");
    const compressedPayload = Buffer.from("small-file-content-".repeat(4096), "utf8");

    function ensureAssets() {
        fs.mkdirSync(assetsDir, { recursive: true });
        fs.mkdirSync(viewsDir, { recursive: true });

        if (!fs.existsSync(staticFilePath)) {
            fs.writeFileSync(staticFilePath, Buffer.alloc(250 * KB, "a"));
        }
    }

    return {
        assetsDir,
        viewsDir,
        staticFilePath,
        compressedPayload,
        streamSizeBytes: STREAM_SIZE_BYTES,
        ensureAssets,
        pipeLargeStream(res, includeContentLength) {
            if (includeContentLength) {
                res.setHeader("Content-Length", String(STREAM_SIZE_BYTES));
            }
            res.setHeader("Content-Type", "application/octet-stream");
            let remaining = STREAM_SIZE_BYTES;
            const stream = new Readable({
                read() {
                    if (remaining <= 0) {
                        this.push(null);
                        return;
                    }

                    const chunk = remaining >= STREAM_CHUNK_SIZE ? STREAM_CHUNK : STREAM_CHUNK.subarray(0, remaining);
                    remaining -= chunk.length;
                    this.push(chunk);
                }
            });

            stream.pipe(res);
        },
        createHashFromRequest(req, done) {
            const hash = crypto.createHash("sha256");
            req.on("data", (chunk) => {
                hash.update(chunk);
            });
            req.on("end", () => {
                done(hash.digest("hex"));
            });
            req.on("error", (error) => {
                done(null, error);
            });
        }
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const frameworkName = args.framework;
    const scenarioName = args.scenario;
    const port = Number(args.port || 3000);

    if (!frameworkName || !scenarioName) {
        throw new Error("Missing required args: --framework and --scenario");
    }

    const express = resolveFramework(frameworkName);
    const app = express();
    const context = createContext();
    const scenarioPath = path.join(__dirname, "scenarios", `${scenarioName}.js`);
    const scenario = require(scenarioPath);

    if (typeof app.set === "function") {
        app.set("etag", false);
        app.set("x-powered-by", false);
        app.set("env", "production");
        if (frameworkName === "fulmine") {
            // Off, so the comparison is between two frameworks doing the work rather than between
            // one of them and a response uWS wrote at startup. Set FULMINE_DECLARATIVE=1 to measure
            // what that shortcut is worth: on a route simple enough to be compiled it is around a
            // fifth more throughput, paid for with chunked framing and no Content-Length.
            app.set("declarative responses", process.env.FULMINE_DECLARATIVE === "1");
        }
    }

    app.get("/__ready", (req, res) => {
        res.send("ok");
    });

    await scenario.setup(app, express, context);

    // profile.js sets PROFILE_OUT and stops us with a message rather than a signal. A signal would
    // be no use: --cpu-prof and the profiler both write on a clean exit, and a killed process on
    // Windows leaves nothing behind at all.
    const profiler = process.env.PROFILE_OUT ? new (require("inspector").Session)() : null;

    const server = app.listen(port, () => {
        if (!profiler) {
            process.stdout.write(`ready:${frameworkName}:${scenarioName}:${port}\n`);
            return;
        }
        profiler.connect();
        profiler.post("Profiler.enable", () => {
            // 100 microseconds rather than the default millisecond. Ten times the samples for the
            // same run, which is what makes a function worth a few microseconds a request come out
            // as a number rather than as quantisation.
            profiler.post("Profiler.setSamplingInterval", { interval: 100 }, () => {
                profiler.post("Profiler.start", () => {
                    process.stdout.write(`ready:${frameworkName}:${scenarioName}:${port}\n`);
                });
            });
        });
    });

    // profile.js asks for a cut at the end of every round and keeps this process alive between
    // them, so that each round is measured on a server that is already warm rather than on one that
    // has just started and is still being compiled.
    process.on("message", (message) => {
        if (!profiler) {
            return;
        }
        if (message.cmd === "exit") {
            process.exit(0);
        }
        profiler.post("Profiler.stop", (err, result) => {
            fs.writeFileSync(message.out, JSON.stringify(result.profile));
            profiler.post("Profiler.start", () => {
                /** @type {any} */ (process).send({ cut: message.out });
            });
        });
    });

    function shutdown() {
        server.close(() => {
            process.exit(0);
        });
    }

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
});
