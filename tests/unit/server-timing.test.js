// express.serverTiming(): the header, and the one field in it nobody else can write.

const test = require("node:test");
const assert = require("node:assert");
const express = require("../../src/index.js");

/**
 * @param {(app: any) => void} setup
 * @param {string} path
 * @param {object} [init]
 * @returns {Promise<{status: number, timing: string|null, body: string}>}
 */
async function ask(setup, path, init) {
    const app = express();
    app.set("etag", false);
    setup(app);
    const server = app.listen(0);
    try {
        const res = await fetch(`http://127.0.0.1:${app.address().port}${path}`, init);
        return { status: res.status, timing: res.headers.get("server-timing"), body: await res.text() };
    } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
}

test("a route µWS answers says so", async () => {
    const answer = await ask((app) => {
        app.use(express.serverTiming());
        app.get("/items/:id", (req, res) => res.json({ id: req.params.id }));
    }, "/items/7");
    assert.match(answer.timing, /route;desc="native"/);
    assert.match(answer.timing, /total;dur=\d+\.\d\d/);
});

test("and one the router had to match says that instead", async () => {
    const answer = await ask((app) => {
        app.use(express.serverTiming());
        app.get(/^\/legacy$/, (req, res) => res.send("legacy"));
    }, "/legacy");
    assert.match(answer.timing, /route;desc="router"/);
    assert.strictEqual(answer.body, "legacy");
});

test("marks of the caller's own ride along, in the order they were added", async () => {
    const answer = await ask((app) => {
        app.use(express.serverTiming());
        app.get("/thing", (req, res) => {
            res.timing("db", 12.4);
            res.timing("cache", undefined, "HIT");
            res.send("ok");
        });
    }, "/thing");
    assert.match(answer.timing, /db;dur=12\.40/);
    assert.match(answer.timing, /cache;desc="HIT"/);
    assert.ok(
        answer.timing.indexOf("db;dur") < answer.timing.indexOf("cache;desc"),
        "the marks keep the order they were made in"
    );
});

test("res.time measures the work it is given, including a promise", async () => {
    const answer = await ask((app) => {
        app.use(express.serverTiming());
        app.get("/sync", (req, res) => {
            const doubled = res.time("work", () => 21 * 2);
            res.send(String(doubled));
        });
        app.get("/async", async (req, res) => {
            const value = await res.time("slow", () => new Promise((resolve) => setTimeout(() => resolve("late"), 20)));
            res.send(value);
        });
    }, "/sync");
    assert.strictEqual(answer.body, "42", "the value comes back");
    assert.match(answer.timing, /work;dur=/);

    const slow = await ask((app) => {
        app.use(express.serverTiming());
        app.get("/async", async (req, res) => {
            const value = await res.time("slow", () => new Promise((resolve) => setTimeout(() => resolve("late"), 20)));
            res.send(value);
        });
    }, "/async");
    assert.strictEqual(slow.body, "late");
    const duration = Number(/slow;dur=([\d.]+)/.exec(slow.timing)[1]);
    assert.ok(duration >= 15, `the promise was timed to where it settled, got ${duration}`);
});

test("a throw inside res.time is still timed, and still thrown", async () => {
    const answer = await ask((app) => {
        app.use(express.serverTiming());
        app.get("/boom", (req, res) => {
            try {
                res.time("failing", () => {
                    throw new Error("no");
                });
            } catch (err) {
                res.send("caught " + err.message);
            }
        });
    }, "/boom");
    assert.strictEqual(answer.body, "caught no");
    assert.match(answer.timing, /failing;dur=/);
});

test("what it reports can be turned off", async () => {
    const answer = await ask((app) => {
        app.use(express.serverTiming({ routing: false, name: "app" }));
        app.get("/quiet", (req, res) => res.send("ok"));
    }, "/quiet");
    assert.ok(!answer.timing.includes("route;desc"), "no routing verdict");
    assert.match(answer.timing, /app;dur=/, "and the total is named as asked");
});

test("a header the application set of its own is kept", async () => {
    const answer = await ask((app) => {
        app.use(express.serverTiming());
        app.get("/both", (req, res) => {
            res.set("Server-Timing", "upstream;dur=9.10");
            res.send("ok");
        });
    }, "/both");
    assert.match(answer.timing, /upstream;dur=9\.10/);
    assert.match(answer.timing, /route;desc=/);
});

test("a rejected promise inside res.time is timed and still rejects", async () => {
    const answer = await ask((app) => {
        app.use(express.serverTiming());
        app.get("/reject", async (req, res) => {
            try {
                await res.time("failing", () => Promise.reject(new Error("late no")));
            } catch (err) {
                res.send("caught " + err.message);
            }
        });
    }, "/reject");
    assert.strictEqual(answer.body, "caught late no");
    assert.match(answer.timing, /failing;dur=/);
});

test("a body written in pieces is stamped once, on the first piece", async () => {
    const answer = await ask((app) => {
        app.use(express.serverTiming());
        app.get("/pieces", (req, res) => {
            res.type("text/plain");
            res.write("one ");
            res.write("two ");
            res.end("three");
        });
    }, "/pieces");
    assert.strictEqual(answer.body, "one two three");
    const stamps = answer.timing.match(/total;dur=/g) ?? [];
    assert.strictEqual(stamps.length, 1, "one total, however many writes there were");
});

test("a response whose head has already gone out is left alone", async () => {
    const answer = await ask((app) => {
        app.use(express.serverTiming());
        app.get("/flushed", (req, res) => {
            res.type("text/plain");
            res.flushHeaders();
            res.end("late");
        });
    }, "/flushed");
    assert.strictEqual(answer.body, "late");
    assert.strictEqual(answer.timing, null, "nothing can be added to a head that is gone");
});

test("a route that reads no header and no query says so", async () => {
    const answer = await ask((app) => {
        // the middleware is on the route rather than on the app, so the analysis can still see
        // what the rest of the chain does
        app.get("/plain", express.serverTiming(), (req, res) => res.send("ok"));
    }, "/plain");
    assert.match(answer.timing, /route;desc="native"/);
});

test("a mark with punctuation in its name is written as a token", async () => {
    const answer = await ask((app) => {
        app.use(express.serverTiming({ total: false }));
        app.get("/odd", (req, res) => {
            res.timing("db query;dur=99", 1);
            res.send("ok");
        });
    }, "/odd");
    assert.match(answer.timing, /dbquerydur99;dur=1\.00/, "the name is stripped to a token");
    assert.ok(!answer.timing.includes("total;dur"), "and the total was turned off");
});
