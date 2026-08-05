// The http3 option, guarded since 2026-08-05: uWS.H3App exists in the pinned build but its
// QUIC stack does not, and the constructor segfaults on Linux and hangs on Windows. The first
// test pins the guard. The second is the canary: it probes H3App in a subprocess, skips while
// the crash is still there, and FAILS the day uWS ships working QUIC, which is the reminder
// to drop the guard, re-enable the readme section and revisit the arena h3 profiles.

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const express = require("../../src/index.js");

test("asking for http3 throws the clear error instead of the native crash", () => {
    assert.throws(
        () =>
            express({
                http3: true,
                uwsOptions: { key_file_name: "k.pem", cert_file_name: "c.pem" }
            }),
        /http3 is not usable with the pinned uWebSockets\.js build/
    );
});

test(
    "uWS H3App listening, the canary for re-enabling http3",
    // Linux only, which is where CI runs and where the docker deployments live: there the
    // constructor segfaults today, verified with uWS alone. On Windows the listener comes up
    // but nothing portable can verify QUIC service, so the canary would cry wolf.
    { skip: process.platform === "win32" ? "the Linux CI carries this canary" : false },
    (t) => {
        // In a subprocess, because a segfault would take the runner with it. Bare construction
        // with no options succeeds even today, so the bar is what the option would actually
        // need: construction with real certificates and a listen callback that fires.
        const fixtures = path.join(__dirname, "..", "fixtures");
        const probe = `
        const uWS = require(${JSON.stringify(path.join(__dirname, "..", "..", "node_modules", "uWebSockets.js"))});
        if (typeof uWS.H3App !== "function") { console.log("absent"); process.exit(0); }
        const app = uWS.H3App({
            key_file_name: ${JSON.stringify(path.join(fixtures, "h3-canary.key"))},
            cert_file_name: ${JSON.stringify(path.join(fixtures, "h3-canary.crt"))}
        });
        app.get("/ping", (res) => res.end("pong"));
        app.listen(19443, (token) => {
            console.log("listening:" + Boolean(token));
            process.exit(0);
        });
    `;
        const result = spawnSync(process.execPath, ["-e", probe], { timeout: 5000, encoding: "utf8" });

        const listening = result.status === 0 && String(result.stdout).includes("listening:true");
        if (!listening) {
            const how =
                result.error && result.error.code === "ETIMEDOUT"
                    ? "hangs"
                    : result.status === null
                      ? "killed"
                      : `exit ${result.status}, out ${JSON.stringify(String(result.stdout).slice(0, 40))}`;
            t.skip(`H3App still broken upstream (${how}): the http3 guard stays`);
            return;
        }
        assert.fail(
            "uWS.H3App now constructs with certificates and listens: QUIC may finally work. Remove " +
                "the guard in application.js, re-verify with a real HTTP/3 client, update the readme " +
                "section and reconsider the arena baseline-h3/static-h3 profiles."
        );
    }
);
