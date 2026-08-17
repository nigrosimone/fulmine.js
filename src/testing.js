/*
Copyright 2026 Nigro Simone

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// express.testing: what listen() decided about each route, as something a test can assert on.
//
// A route is answered by µWS itself only while it stays eligible, and eligibility is not a property
// of the route alone: a `const` in the wrong place, a middleware that reads a header, a new route
// written above an old one, and it quietly falls back to the ordinary router. The answer is still
// correct, which is why nothing complains. What changes is the throughput, and by the time anyone
// notices, the commit that did it is three weeks back.
//
// `npx fulmine profile` prints the same verdicts for a human to read. This is the half a test can
// hold on to, so a pull request that loses the fast path fails in CI with the reason written out
// instead of being found in production.

"use strict";

/**
 * Every route of an application and of the routers mounted under it, each with the path it answers
 * from the outside.
 *
 * @param {any} router
 * @param {string} prefix
 * @param {any[]} [into]
 * @returns {{route: any, full: string}[]}
 */
function collectRoutes(router, prefix, into = []) {
    for (const route of router._routes ?? []) {
        const full = prefix + (typeof route.path === "string" ? route.path : String(route.pattern)) || "/";
        into.push({ route, full });
        const mounted = route.callbacks?.[0];
        if (mounted && Array.isArray(mounted._routes)) {
            collectRoutes(mounted, typeof route.path === "string" ? prefix + route.path : prefix, into);
        }
    }
    return into;
}

/**
 * Compiles the routes, which is what listen() does before it binds, without binding anything. Once
 * per application: a second compilation would register everything with µWS twice.
 *
 * @param {any} app
 */
function compileOnce(app) {
    if (app.listenCalled || app._testingCompiled) {
        return;
    }
    app._testingCompiled = true;
    app._compileOptimizedRoutes();
}

/**
 * What compiling the routes decided, one entry per route, in the order they were registered.
 *
 * This is the primitive the two assertions below are written on, and it is exported because an
 * application with rules of its own is better served asserting them itself: how many routes may
 * fall back, which ones may read headers, that the one route carrying the traffic is declarative.
 *
 * @param {any} app an application, listening or not
 * @returns {{method: string, path: string, native: boolean, declarative: boolean, skipHeaders: boolean,
 *   skipQuery: boolean, reason: string|undefined}[]}
 */
function routeReport(app) {
    compileOnce(app);
    return collectRoutes(app, "")
        .filter(({ route }) => !route.use)
        .map(({ route, full }) => ({
            method: String(route.method),
            path: full,
            native: Boolean(route._native),
            declarative: Boolean(route._native?.declarative),
            skipHeaders: Boolean(route._native?.skipHeaders),
            skipQuery: Boolean(route._native?.skipQuery),
            reason: route._native ? undefined : (route._whyGeneric ?? "it was not eligible")
        }));
}

/**
 * Whether one of the patterns given names this route.
 *
 * A pattern is a path as it was registered, not a URL: "/api/items/:id" and not "/api/items/7". It
 * may carry the method, "GET /health", and it may end in "*" to name everything under a prefix.
 *
 * @param {{method: string, path: string}} entry
 * @param {string} pattern
 * @returns {boolean}
 */
function names(entry, pattern) {
    let path = pattern;
    const space = pattern.indexOf(" ");
    if (space !== -1) {
        const method = pattern.slice(0, space).toUpperCase();
        if (method !== entry.method.toUpperCase()) {
            return false;
        }
        path = pattern.slice(space + 1);
    }
    if (path.endsWith("*")) {
        return entry.path.startsWith(path.slice(0, -1));
    }
    return entry.path === path;
}

/**
 * The routes the patterns name, refusing a pattern that names none: a test that asserts about a
 * route it misspelled has to fail rather than pass on an empty list.
 *
 * @param {any} app
 * @param {string|string[]} patterns
 * @param {string} caller the name in the message
 * @returns {ReturnType<typeof routeReport>}
 */
function select(app, patterns, caller) {
    const wanted = typeof patterns === "string" ? [patterns] : patterns;
    if (!Array.isArray(wanted) || wanted.length === 0) {
        throw new TypeError(`${caller} needs a path, or a list of them, to check`);
    }
    const report = routeReport(app);
    const selected = [];
    for (const pattern of wanted) {
        const matched = report.filter((entry) => names(entry, pattern));
        if (matched.length === 0) {
            throw new Error(
                `${caller}: no route is registered as "${pattern}".\n` +
                    `The paths this application has are:\n` +
                    report.map((entry) => `  ${entry.method} ${entry.path}`).join("\n")
            );
        }
        for (const entry of matched) {
            if (!selected.includes(entry)) {
                selected.push(entry);
            }
        }
    }
    return selected;
}

/**
 * Throws unless every route named is answered by µWS itself.
 *
 * The message is the point: it names each route that fell back and why, in the same words
 * `npx fulmine profile` uses, so the failure says what to change.
 *
 * @param {any} app
 * @param {string|string[]} patterns paths as they were registered, "GET /path" to pin the method,
 *   a trailing "*" for everything under a prefix
 */
function expectNative(app, patterns) {
    const lost = select(app, patterns, "expectNative").filter((entry) => !entry.native);
    if (lost.length === 0) {
        return;
    }
    throw new Error(
        `${lost.length} route(s) are no longer answered by µWS itself:\n\n` +
            lost.map((entry) => `  ${entry.method} ${entry.path}\n    ${entry.reason}`).join("\n") +
            `\n\nRun \`npx fulmine profile\` to see the whole picture.`
    );
}

/**
 * Why a route µWS already matches is still not compiled into a response.
 *
 * The handler is the last answer, not the first: three refusals come before it, and blaming the
 * handler for one of those sends the reader to rewrite something that was already simple enough.
 *
 * @param {any} app
 * @param {{path: string}} entry
 * @returns {string}
 */
function whyNotCompiled(app, entry) {
    if (!app.get("declarative responses")) {
        return "answered by µWS, but declarative responses are turned off";
    }
    if (entry.path.includes(":")) {
        return "answered by µWS, but the route captures, and nothing runs to decode the value";
    }
    if (app.get("etag")) {
        return (
            "answered by µWS, but a response carrying an ETag could never answer the conditional " +
            'request it invites: app.set("etag", false) is what puts a route here'
        );
    }
    return "answered by µWS, but the handler is not simple enough to compile";
}

/**
 * Throws unless every route named is answered from a response written at startup, which is the
 * step past native: µWS answers it without entering javascript at all.
 *
 * @param {any} app
 * @param {string|string[]} patterns as in expectNative
 */
function expectDeclarative(app, patterns) {
    const lost = select(app, patterns, "expectDeclarative").filter((entry) => !entry.declarative);
    if (lost.length === 0) {
        return;
    }
    throw new Error(
        `${lost.length} route(s) are no longer compiled into a response:\n\n` +
            lost
                .map(
                    (entry) =>
                        `  ${entry.method} ${entry.path}\n    ` +
                        (entry.native ? whyNotCompiled(app, entry) : entry.reason)
                )
                .join("\n") +
            `\n\nRun \`npx fulmine profile\` to see the whole picture.`
    );
}

module.exports = { routeReport, expectNative, expectDeclarative, collectRoutes };
