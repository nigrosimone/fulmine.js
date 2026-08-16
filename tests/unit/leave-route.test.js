// req._leaveRoute is the continuation that abandons the rest of a route and carries on with the
// route after it, which is what res.sendFile reports a failure to. It is bound on the first route
// that has more than one callback rather than for every request, so what these pin is that the
// laziness changed nothing: the identity express's own res.format test relies on, the skipping,
// and where a sendFile error lands.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const express = require("../../src/index.js");

/**
 * @param {(app: any) => void} setup
 * @returns {Promise<{url: string, close: () => void}>}
 */
function serve(setup) {
    return new Promise((resolve) => {
        const app = express();
        setup(app);
        app.listen(0, () => {
            resolve({ url: `http://localhost:${app.address().port}`, close: () => app.close() });
        });
    });
}

test("a route with one callback hands over the very next it received", async () => {
    let sameObject = null;
    const { url, close } = await serve((app) => {
        app.get("/", (req, res) => {
            // express hands res.format's handlers the next its own layer received, and asserts
            // that identity: with a single callback the two steps are the same step
            sameObject = req._leaveRoute === req.next;
            res.send("ok");
        });
    });

    await fetch(url);
    assert.strictEqual(sameObject, true, "_leaveRoute must be req.next itself when there is nothing to leave");

    close();
});

test("a route with several callbacks gets a step of its own, and it skips the rest", async () => {
    const ran = [];
    let differs = null;
    const { url, close } = await serve((app) => {
        app.get(
            "/",
            (req, res, next) => {
                ran.push("first");
                differs = req._leaveRoute !== req.next;
                // leaving the route abandons the callback below and resumes at the route after it
                req._leaveRoute();
            },
            (req, res) => {
                ran.push("second");
                res.send("second");
            }
        );
        app.get("/", (req, res) => {
            ran.push("later route");
            res.send("later route");
        });
    });

    const body = await (await fetch(url)).text();
    assert.strictEqual(differs, true, "with more than one callback the two steps must differ");
    assert.deepStrictEqual(ran, ["first", "later route"], "the rest of the route must be skipped");
    assert.strictEqual(body, "later route");

    close();
});

test("leaving a route with an error skips to an error handler", async () => {
    const ran = [];
    const { url, close } = await serve((app) => {
        app.get(
            "/",
            (req, res, next) => {
                req._leaveRoute(new Error("left"));
            },
            (req, res) => {
                ran.push("second");
                res.send("second");
            }
        );
        app.use((err, req, res, next) => {
            res.status(500).send("caught " + err.message);
        });
    });

    const res = await fetch(url);
    assert.strictEqual(res.status, 500);
    assert.strictEqual(await res.text(), "caught left");
    assert.deepStrictEqual(ran, [], "the callback after it must not run");

    close();
});

test("a sendFile failure leaves the route rather than reaching a handler inside it", async () => {
    const ran = [];
    const { url, close } = await serve((app) => {
        app.get(
            "/",
            (req, res, next) => next(),
            (req, res) => res.sendFile(path.join(__dirname, "nothing-is-here.txt")),
            // a four argument handler written inside the route, which express does not reach for
            // this: the error leaves the route and goes to the router's handlers
            (err, req, res, next) => {
                ran.push("inside the route");
                next(err);
            }
        );
        app.use((err, req, res, next) => {
            ran.push("router handler");
            res.status(404).send("gone");
        });
    });

    const res = await fetch(url);
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(ran, ["router handler"], "only the router's handler may see it");

    close();
});

test("the step is bound once for the whole request, however many routes ask", async () => {
    const seen = [];
    const { url, close } = await serve((app) => {
        const record = (req, res, next) => {
            seen.push(req._leaveRoute);
            next();
        };
        app.get("/", record, (req, res, next) => next());
        app.get("/", record, (req, res) => res.send("ok"));
    });

    await fetch(url);
    assert.strictEqual(seen.length, 2, "both routes must have been entered");
    assert.strictEqual(seen[0], seen[1], "the same bound step must be reused, not built per route");

    close();
});
