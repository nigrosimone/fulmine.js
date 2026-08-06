// Which routes reach the native µWS router, pinned so that losing one is a failing test.
//
// This exists because a route quietly falling off the fast path costs a great deal and shows up
// nowhere: the application still answers, with the same bytes, only slower. Exactly that had
// happened to `:param` routes by 2026-08-02, in this project and in the one it is derived from,
// while the machinery for handling them natively sat in _registerUwsRoute as dead code.
//
// The comparison suite cannot see this. Every test there runs the same file against Express and
// against Fulmine and compares the output, and the output is identical whichever path served it.
// So it has to be asserted from the inside.
//
// A route is on the fast path when route.optimizedPath is set, which is what _compileOptimizedRoutes
// leaves behind when it hands the route to µWS. What µWS itself can match was measured rather than
// assumed:
//
//   :param        one non-empty segment, anywhere in the path, any number of times
//   /*            the rest of the path, including nothing
//   literals      matched case sensitively, and a trailing slash is significant
//   getParameter  hands back the raw, still-encoded text
//
// so a pattern is a candidate only when Express would match exactly the same set of paths.

const test = require("node:test");
const assert = require("node:assert");

const express = require("../../src/index.js");

/**
 * Registers each path on a fresh app, starts it, and answers which of them ended up on the native
 * router. Starting it matters: _compileOptimizedRoutes runs from listen(), since it needs every
 * route to have been registered first.
 *
 * @param {string[]} paths
 * @param {(app: any) => void} [extra] anything else to set up before listening
 * @returns {Promise<Record<string, boolean>>}
 */
function optimizedFor(paths, extra) {
    return new Promise((resolve) => {
        const app = express();
        for (const path of paths) {
            app.get(path, (req, res) => res.send("ok"));
        }
        if (extra) {
            extra(app);
        }
        app.listen(0, () => {
            const answer = {};
            for (const route of app._routes) {
                if (typeof route.path === "string" && paths.includes(route.path)) {
                    answer[route.path] = !!route.optimizedPath;
                }
            }
            app.close();
            resolve(answer);
        });
    });
}

/**
 * The paths that reached µWS, wherever they were registered. optimizedFor cannot see into a mounted
 * router: a route reached through a mount is handed over as a copy carrying the prefix, so the
 * route object in the router's own list never learns that it was optimized.
 *
 * @param {(app: any) => void} setup
 * @returns {Promise<string[]>}
 */
function nativePaths(setup) {
    return new Promise((resolve) => {
        const app = express();
        setup(app);
        const registered = [];
        const register = app._registerUwsRoute;
        app._registerUwsRoute = function (route, chain) {
            registered.push(route.path);
            return register.call(this, route, chain);
        };
        app.listen(0, () => {
            app.close();
            resolve(registered);
        });
    });
}

test("a callable app or router is still a usable function", () => {
    // Setting a function's prototype to a class prototype takes Function.prototype out of its
    // chain, and apply and call with it. Node emits a request to its listener with handler.apply,
    // so an app without one is not something http.createServer can serve: that was a CI failure on
    // Node 24 while Node 26 called the listener another way and passed.
    for (const callable of [express(), express.Router()]) {
        assert.strictEqual(typeof callable, "function");
        assert.strictEqual(typeof callable.apply, "function");
        assert.strictEqual(typeof callable.call, "function");
        // and bind is the BIND verb, not Function.prototype.bind, which is the collision Express
        // resolves the same way
        callable.bind("/thing", () => {});
        assert.strictEqual(callable._routes.at(-1).method, "BIND", "bind registers a route");
    }

    // and the class prototype is still in the chain, which is what express.application is for:
    // a method added there has to reach apps that already exist
    const app = express();
    assert.strictEqual(app.constructor.name, "Application");
    assert.strictEqual(typeof app.listen, "function");
});

test("a plain path is served by the native router", async () => {
    const optimized = await optimizedFor(["/", "/health", "/a/b/c", "/api/v1/users"]);
    for (const [path, isOptimized] of Object.entries(optimized)) {
        assert.strictEqual(isOptimized, true, `${path} should be on the native router`);
    }
});

test("a pattern µWS cannot match itself is not", async () => {
    // A wildcard is not the same shape as µWS's /*: Express 5 names it and hands over an array of
    // segments, and {*splat} also matches the mount point itself. An optional group has no
    // equivalent at all. Both have to be matched here.
    const optimized = await optimizedFor(["/files/{*rest}", "/a/{:b}", "/x{/:page}"]);
    for (const [path, isOptimized] of Object.entries(optimized)) {
        assert.strictEqual(isOptimized, false, `${path} cannot be matched natively`);
    }
});

test("case insensitive routing keeps the native router for the registered case", async () => {
    // µWS matches bytes, so the native registration answers requests in the registered case and
    // any other case falls through to the catch-all, whose dispatch folds. Both answer what
    // express answers, so insensitive routing, the default since it is express's, costs nothing.
    const optimized = await optimizedFor(["/health"], (app) => app.set("case sensitive routing", false));
    assert.strictEqual(optimized["/health"], true);
});

test("and guards the specificity argument where it leans on case", async () => {
    // µWS prefers /differ/FOO/:x for /differ/FOO/9, which agrees with express, but /differ/foo/9
    // matches that route under folding while µWS's bytes say it does not, so it arrives at the
    // later route instead. Both stay native and the later one carries a guard that sends exactly
    // those requests to the generic router; the answers are compared against express in
    // tests/tests/routing/case-variant-beats-param.js.
    for (const pair of [
        ["/differ/FOO/:x", "/differ/:user/:x"],
        ["/differ/foo/:x", "/differ/:user/:x"]
    ]) {
        assert.deepStrictEqual(await optimizedFor(pair), { [pair[0]]: true, [pair[1]]: true });
    }
});

test("a :param route is on the native router", async () => {
    // The commonest route shape there is, and the one this file was written to protect. It reached
    // the native router on 2026-08-02; before that it went the slow way in this project and in the
    // one it is derived from, while the machinery to handle it sat unused.
    const optimized = await optimizedFor(["/users/:id", "/users/:id/posts", "/a/:b/c/:d"]);
    for (const [path, isOptimized] of Object.entries(optimized)) {
        assert.strictEqual(isOptimized, true, `${path} should be on the native router`);
    }
});

test("a parameter that is not a whole segment is not", async () => {
    // µWS matches ":from" against a whole segment, so "/flights/:from-:to" would be one parameter
    // to it and two to Express. A route that matched different requests would be a great deal
    // worse than a route that is merely slower.
    const optimized = await optimizedFor(["/flights/:from-:to", "/file-:name", "/:a.:b"]);
    for (const [path, isOptimized] of Object.entries(optimized)) {
        assert.strictEqual(isOptimized, false, `${path} cannot be matched natively`);
    }
});

test("a mounted router's parameter routes are native when nothing after them could match", async () => {
    // The one that matters for an application of any size, since routes live in routers. A native
    // chain that runs out resumes after the mount rather than inside the router, so a route may
    // only go native when no later route in that router could have answered instead: /orders/:id
    // and /invoices/:id cannot both match anything, and neither can /orders/:id and its /items.
    const paths = await nativePaths((app) => {
        const router = express.Router();
        router.get("/orders/:id", (req, res) => res.send("ok"));
        router.get("/orders/:id/items", (req, res) => res.send("ok"));
        router.get("/invoices/:id", (req, res) => res.send("ok"));
        app.use("/api", router);
    });
    assert.deepStrictEqual(paths.filter((path) => path.startsWith("/api")).sort(), [
        "/api/invoices/:id",
        "/api/orders/:id",
        "/api/orders/:id/items"
    ]);
});

test("and not when something after them could", async () => {
    const paths = await nativePaths((app) => {
        // Express answers /users/me with /users/:id, since it was registered first, and µWS would
        // answer it with /users/me, since it prefers the literal. Neither of the two can go native
        const users = express.Router();
        users.get("/users/:id", (req, res) => res.send("ok"));
        users.get("/users/me", (req, res) => res.send("ok"));
        app.use("/api", users);

        // and middleware registered after a route could match anything at all
        const things = express.Router();
        things.get("/things/:id", (req, res) => res.send("ok"));
        things.use((req, res, next) => next());
        app.use("/other", things);
    });
    assert.deepStrictEqual(
        paths.filter((path) => path.startsWith("/api") || path.startsWith("/other")),
        []
    );
});

test("a param callback does not send the route back to the slow path", async () => {
    // It used to. The native chain is walked by the app whatever it contains, so it consulted the
    // app's param callbacks, and a mounted router's own would never have fired. Every route carries
    // the router it was registered on now, so the right callbacks run and both of these are native.
    const paths = await nativePaths((app) => {
        app.param("id", (req, res, next) => next());
        app.get("/users/:id", (req, res) => res.send("ok"));

        const router = express.Router();
        router.param("uid", (req, res, next) => next());
        router.get("/profile/:uid", (req, res) => res.send("ok"));
        app.use("/api", router);
    });
    assert.ok(paths.includes("/users/:id"), `expected /users/:id among ${paths.join(", ")}`);
    assert.ok(paths.includes("/api/profile/:uid"), `expected /api/profile/:uid among ${paths.join(", ")}`);
});

test("a parameter route stays off it when an earlier route could answer some of its paths", async () => {
    // µWS would pick /differ/foo/:user for /differ/foo/bob, express the route registered first
    assert.deepStrictEqual(await optimizedFor(["/differ/:user/bob", "/differ/foo/:user"]), {
        "/differ/:user/bob": true,
        "/differ/foo/:user": false
    });
    // the other way round µWS agrees with express: the literal is the more specific of the two
    assert.deepStrictEqual(await optimizedFor(["/users/me", "/users/:id"]), {
        "/users/me": true,
        "/users/:id": true
    });
    // and a mount that answers part of them keeps it off, since a mount is not on µWS's router
    const paths = await nativePaths((app) => {
        app.use("/shop/sale", (req, res, next) => next());
        app.get("/shop/:id/items", (req, res) => res.send("ok"));
        app.get("/shop/:id", (req, res) => res.send("ok"));
    });
    assert.deepStrictEqual(paths, []);
});

test("overlapping param shapes stay off the native router, insensitive mounts do not", async () => {
    // µWS would answer /a/hello with the second registration under the wrong names
    const paths = await nativePaths((app) => {
        app.get("/a/:x", (req, res, next) => next());
        app.use((req, res, next) => next());
        app.get("/a/:y", (req, res) => res.send("ok"));
    });
    assert.ok(paths.includes("/a/:x"), "/a/:x stays native");
    assert.ok(!paths.includes("/a/:y"), "/a/:y falls back to ordinary dispatch");

    // a case-insensitive router, which is what express.Router() builds, is walked like any
    // other: its own _optimizeRoute guards its routes under its own setting
    const insensitive = await nativePaths((app) => {
        const router = express.Router({ caseSensitive: false });
        router.get("/foo", (req, res) => res.send("ok"));
        app.use("/sub", router);
    });
    assert.deepStrictEqual(
        insensitive.filter((p) => p.startsWith("/sub")),
        ["/sub/foo"]
    );
});
