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

// Written as a todo rather than an assertion, because it is the one that is meant to change.
//
// µWS matches :param itself, `_registerUwsRoute` already reads the values back with getParameter,
// and `/users/:id` is the commonest route shape there is. Today it is not on the fast path, and the
// day it is, this test says so out loud instead of the change passing unnoticed.
test("a :param route is not on the native router yet", async () => {
    const optimized = await optimizedFor(["/users/:id", "/users/:id/posts", "/a/:b/c/:d"]);
    for (const [path, isOptimized] of Object.entries(optimized)) {
        assert.strictEqual(isOptimized, false, `${path}: if this now fails, the optimisation landed`);
    }
});
