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

// express.testing: what listen() decided about each route, for a test to assert on. A route falls
// off the native path silently (a middleware reading a header, a new route above an old one) and
// only the throughput changes: this is what makes such a pull request fail in CI.

"use strict";

const { work, names: workNames } = require("./work.js");

/** @typedef {import("./request.js")} Request */
/** @typedef {import("./response.js")} Response */
/** @typedef {import("./router.js")} Router */
/** @typedef {import("./application.js").Application} Application */
/** @typedef {import("./router-utils.js").RouteEntry} RouteEntry */

/**
 * Every route of an application and its mounted routers, with the path it answers from outside.
 *
 * @param {Router} router
 * @param {string} prefix
 * @param {{route: RouteEntry, full: string}[]} [into]
 * @returns {{route: RouteEntry, full: string}[]}
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
 * Compiles the routes as listen() does, without binding, once per application.
 *
 * @param {Application} app
 */
function compileOnce(app) {
    if (app.listenCalled || app._testingCompiled) {
        return;
    }
    app._testingCompiled = true;
    app._compileOptimizedRoutes();
}

/**
 * What compiling the routes decided, one entry per route in registration order; what the two
 * assertions below read.
 *
 * @param {Application} app an application, listening or not
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
 * Whether the pattern names this route: a registered path, an optional method in front, an
 * optional "*" at the end.
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
 * The routes the patterns name; a pattern naming none throws.
 *
 * @param {Application} app
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
    const selected = /** @type {ReturnType<typeof routeReport>} */ ([]);
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
 * Throws unless every route named is answered by uWS itself, with the reasons profile prints.
 *
 * @param {Application} app
 * @param {string|string[]} patterns registered paths, "GET /path" to pin the method, a trailing "*"
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
 * Why a native route is still not compiled into a response, the handler being the last answer.
 *
 * @param {Application} app
 * @param {{path: string}} entry
 * @returns {string}
 */
function whyNotCompiled(app, entry) {
    if (!app.get("declarative responses")) {
        return "answered by µWS, but declarative responses are turned off";
    }
    if (entry.path.includes(":") && !app.get("declarative request values")) {
        return (
            "answered by µWS, but the route captures, and nothing runs to decode the value: " +
            'app.set("declarative request values", true) is what puts a route here'
        );
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
 * Throws unless every route named is compiled into a response, answered without javascript.
 *
 * @param {Application} app
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

/**
 * What this request made the framework do, see src/work.js.
 *
 * @param {Request} req
 * @param {Response} res
 * @returns {import("./work.js").Work}
 */
function workReport(req, res) {
    return work(req, res);
}

// the work a fast request does none of
const LAZY = ["headers", "query", "body", "requestStream", "responseStream", "socket"];

/**
 * Throws if this request built anything it did not have to: a native route still slows down if a
 * middleware reads `req.headers.host`. `allow` names what is expected here.
 *
 * @param {Request} req
 * @param {Response} res
 * @param {object} [options]
 * @param {string[]} [options.allow]
 */
function expectLazy(req, res, options) {
    const allowed = options?.allow ?? [];
    for (const field of allowed) {
        if (!LAZY.includes(field)) {
            throw new TypeError(`expectLazy: "${field}" is not one of ${LAZY.join(", ")}`);
        }
    }
    const done = work(req, res);
    const unwanted = { ...done };
    for (const field of allowed) {
        unwanted[field] = false;
    }
    const listed = workNames(unwanted);
    if (listed.length === 0) {
        return;
    }
    throw new Error(
        `${req.method} ${req.originalUrl} did work a fast request does not: ${listed.join(", ")}.\n` +
            `Run \`npx fulmine explain ${req.route?.path ?? req.path}\` to see what the chain asks for.`
    );
}

module.exports = { routeReport, expectNative, expectDeclarative, collectRoutes, workReport, expectLazy };
