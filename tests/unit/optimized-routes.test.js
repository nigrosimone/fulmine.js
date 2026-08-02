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

test("case insensitive routing turns the native router off altogether", async () => {
    // µWS matches literals case sensitively and offers no way to ask for anything else, so an
    // application that wants /Users to answer /users cannot use it for any route.
    const optimized = await optimizedFor(["/health"], (app) => app.set("case sensitive routing", false));
    assert.strictEqual(optimized["/health"], false);
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

test("app.param() sends parameter routes back to the slow path", async () => {
    // The native chain is run by the app, so it consults the app's param callbacks. A mounted
    // router's own would never fire, and rather than teach the chain who owns each route, a path
    // with parameters goes the slow way whenever any param callback is registered.
    const optimized = await optimizedFor(["/users/:id"], (app) => app.param("id", (req, res, next) => next()));
    assert.strictEqual(optimized["/users/:id"], false);

    // a plain path has no parameters to call back about, so it is unaffected
    const plain = await optimizedFor(["/health"], (app) => app.param("id", (req, res, next) => next()));
    assert.strictEqual(plain["/health"], true);
});
