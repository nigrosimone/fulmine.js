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

"use strict";

// app.uws(method, path, handler): a route µWS serves with the handler as it was written, (res, req)
// over µWS's own objects. No Request, no Response, no middleware, no router walk: what a bare µWS
// application would do, inside one that also serves Express routes.
//
// It answers before the Express application on every path its pattern takes, wherever it was
// written: a route that bypasses the router cannot be ordered among its layers. µWS picks by
// specificity rather than by order, so that only holds if no native registration is more specific
// than it on the same paths. compileOptimizedRoutes asks uwsRouteTakes and leaves such a route to
// the catch-all, which every µWS pattern is more specific than, and registerUwsRoutes runs after
// the catch-all, since on the same pattern and method µWS calls the last one registered.

const { pathsCanOverlap } = require("./utils.js");
const { collectMounted, joinPaths } = require("./websocket.js");

/** @typedef {import("./router.js")} Router */
/** @typedef {import("./application.js").Application} Application */
/** @typedef {import("uWebSockets.js").HttpRequest} UwsRequest */
/** @typedef {import("uWebSockets.js").HttpResponse} UwsResponse */
/**
 * What µWS takes as a route: a function it calls, or the ArrayBuffer a DeclarativeResponse's end()
 * returns, which it answers with without entering JavaScript.
 *
 * @typedef {((res: UwsResponse, req: UwsRequest) => void)|ArrayBuffer} UwsHandler
 */

/**
 * One app.uws() registration as the router keeps it.
 *
 * @typedef {object} UwsRoute
 * @property {string} method the HTTP method in capitals, or "ANY"
 * @property {string} uwsMethod the TemplatedApp method that registers it: get, del, any, ...
 * @property {string} path the pattern as written, µWS's syntax
 * @property {UwsHandler} handler handed to µWS untouched
 */

// what app.uws() accepts as a method, to the TemplatedApp method that registers it
/** @type {Record<string, string>} */
const UWS_METHODS = {
    get: "get",
    post: "post",
    put: "put",
    delete: "del",
    del: "del",
    patch: "patch",
    options: "options",
    head: "head",
    connect: "connect",
    trace: "trace",
    any: "any",
    all: "any"
};

/**
 * Checks one app.uws() call where it is written, rather than at listen() where the line that made
 * the mistake is long gone, and returns the entry to keep.
 *
 * @param {unknown} method
 * @param {unknown} path
 * @param {unknown} handler
 * @returns {UwsRoute}
 */
function makeUwsRoute(method, path, handler) {
    const uwsMethod = typeof method === "string" ? UWS_METHODS[method.toLowerCase()] : undefined;
    if (uwsMethod === undefined) {
        throw new TypeError(
            `app.uws() method must be one of ${Object.keys(UWS_METHODS).join(", ")}, got ${String(method)}`
        );
    }
    if (typeof path !== "string" || path[0] !== "/") {
        throw new TypeError("app.uws() requires a path string starting with /, in µWS's own pattern syntax");
    }
    if (typeof handler !== "function" && !(handler instanceof ArrayBuffer)) {
        throw new TypeError(
            "app.uws() requires a handler function, called by µWS as (res, req), or a DeclarativeResponse's end()"
        );
    }
    return {
        method: uwsMethod === "del" ? "DELETE" : uwsMethod.toUpperCase(),
        uwsMethod,
        path,
        handler: /** @type {UwsHandler} */ (handler)
    };
}

/**
 * Every app.uws() route reachable from the application, with the mount paths applied. µWS has to
 * be able to match the mount the way it matches a route, since nothing would fall back.
 *
 * @param {Router} root
 * @returns {UwsRoute[]}
 */
function collectUwsRoutes(root) {
    /** @type {{entry: UwsRoute, prefix: string|null}[]} */
    const found = [];
    collectMounted(root, "_uwsRoutes", "", found, new Set());
    return found.map(({ entry, prefix }) => {
        if (prefix === null) {
            throw new Error(
                `app.uws() route "${entry.path}" sits under a mount µWS cannot match. ` +
                    "Mount the router on a literal path, or on one whose parameters are whole segments."
            );
        }
        return { ...entry, path: joinPaths(prefix, entry.path) };
    });
}

/**
 * Whether two methods can land on the same request: either is ANY, they are the same, or one is
 * the GET whose native registration carries a HEAD twin.
 *
 * @param {string} uwsRouteMethod
 * @param {string} routeMethod the Express route's, "ALL" for app.all()
 * @returns {boolean}
 */
function methodsMeet(uwsRouteMethod, routeMethod) {
    return (
        uwsRouteMethod === "ANY" ||
        routeMethod === "ALL" ||
        uwsRouteMethod === routeMethod ||
        (uwsRouteMethod === "HEAD" && routeMethod === "GET")
    );
}

/**
 * The app.uws() route that could take a request a native registration of this Express route would
 * answer, so the Express route has to stay off µWS's table. Compared byte for byte, the way µWS
 * matches both; "do not know" is yes, which costs the Express route its native registration and
 * nothing else.
 *
 * @param {UwsRoute[]} uwsRoutes
 * @param {string} method the Express route's method, "ALL" for app.all()
 * @param {string} path the whole path the native registration would get, mounts included
 * @param {boolean} strict whether the trailing-slash twin is registered too
 * @returns {UwsRoute|undefined}
 */
function uwsRouteTakes(uwsRoutes, method, path, strict) {
    const twin = !strict && path[path.length - 1] !== "/" ? path + "/" : null;
    for (const uwsRoute of uwsRoutes) {
        if (!methodsMeet(uwsRoute.method, method)) {
            continue;
        }
        if (pathsCanOverlap(uwsRoute.path, path) || (twin !== null && pathsCanOverlap(uwsRoute.path, twin))) {
            return uwsRoute;
        }
    }
    return undefined;
}

/**
 * Hands every app.uws() route to µWS. Called from listen() after the catch-all, so a route on
 * `/*` itself is the one µWS calls.
 *
 * @param {Application} app
 * @param {UwsRoute[]} [routes] already collected, as compileOptimizedRoutes did
 */
function registerUwsRoutes(app, routes = collectUwsRoutes(app)) {
    for (const route of routes) {
        app.uwsApp[route.uwsMethod](route.path, route.handler);
    }
}

module.exports = { makeUwsRoute, collectUwsRoutes, uwsRouteTakes, registerUwsRoutes };
