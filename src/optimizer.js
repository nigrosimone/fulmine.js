/*
Copyright 2024 dimden.dev
Copyright 2026 Nigro Simone

This file is derived from Ultimate Express and has been modified.

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

/** @typedef {import("./router.js")} Router */
/** @typedef {import("./router-utils.js").RouteEntry} RouteEntry */
/** @typedef {import("./application.js").Application} Application */

const {
    patternToRegex,
    needsConversionToRegex,
    canBeOptimized,
    canBeOptimizedWithParams,
    pathsCanOverlap,
    uwsPrefersEarlier,
    NullObject
} = require("./utils.js");
const Walk = require("./walk.js");
const compileDeclarative = require("./declarative.js");
const { chainUsage } = require("./usage.js");
const {
    HAS_LETTER,
    anyGuardHits,
    resCodes,
    resDecMethods,
    nativeDone,
    nativeFail,
    nativePreset,
    hasErrorMiddleware,
    couldAnswer,
    shadowsLeaf,
    headEntersGuard,
    guardsInside,
    supportedUwsMethods,
    regExParam
} = require("./router-utils.js");

// router.js requires this file while still being evaluated, so it hands its class over instead
/** @type {typeof import("./router.js")} */
let Router;

/**
 * @param {typeof import("./router.js")} cls
 */
function useRouterClass(cls) {
    Router = cls;
}

/**
 * The chain a request walks to reach this route, or false when it cannot be known ahead of time:
 * everything registered before it that could also match, in order.
 *
 * @param {Router} router
 * @param {RouteEntry} route
 * @param {RouteEntry[]} routes every route of this router, in registration order
 * @returns {RouteEntry[]|false} the chain, ending in the route itself
 */
function optimizeRoute(router, route, routes) {
    const optimizedPath = [];
    // a route with a parameter is compared shape against shape, not text
    const withParams = typeof route.path === "string" && route.path.includes(":");
    // folded under insensitive routing; uWS still matches bytes, another case takes the fallback
    const caseSensitive = router._caseSensitive();
    const routePathFolded = caseSensitive || typeof route.path !== "string" ? route.path : route.path.toLowerCase();
    const strictHere = (route.owner ?? router)._strictRouting();
    /** @type {string[]|null} earlier literals a case variant could smuggle a request past */
    let caseGuards = null;
    // whether the HEAD twin has to stay generic, see headEnters
    let headGeneric = false;

    for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        if (r.routeKey > route.routeKey) {
            break;
        }
        if (r === route) {
            continue;
        }
        if (!r.all && r.method !== route.method) {
            if (!(r.method === "HEAD" && route.method === "GET")) {
                // a mount's chain is computed once for every method under it, and an earlier route
                // of another method belongs only in some leaves' chains: left to ordinary dispatch
                if (route.use && typeof route.path === "string" && couldAnswer(r, route.path)) {
                    return false;
                }
                // Express exempts HEAD from the method check: a HEAD enters a matching route of
                // any verb and its param() callbacks run, as the generic walk does. The chain
                // cannot say whether such a route matches, so the HEAD twin stays generic
                if (route.method === "GET" && headEnters(r, route, caseSensitive, strictHere)) {
                    headGeneric = true;
                }
                continue;
            }
        }

        // a route that is not a mount answers the mount point, not the subtree, and in the chain
        // it ran for the whole of it: router.all("/:p1") answered /posts/a-b. See guardsInside
        if (route.use && !r.use && typeof route.path === "string" && couldAnswer(r, route.path)) {
            return false;
        }

        // a RegExp mount runs where its match starts the path and ends on a separator, decidable
        // against a literal path only
        if (r.regexMount) {
            const matched = typeof route.path === "string" ? r.pattern.exec(route.path) : null;
            const runsAlways =
                matched !== null &&
                !matched[0].includes(":") &&
                route.path.slice(0, matched[0].length) === matched[0] &&
                (route.path.length === matched[0].length || route.path[matched[0].length] === "/");
            if (runsAlways) {
                if (r.callbacks.some((c) => c instanceof Router)) {
                    return false;
                }
                optimizedPath.push(r);
                continue;
            }
            // it may answer some of this route's paths, which a chain cannot say
            if (matched !== null || withParams) {
                return false;
            }
            continue;
        }

        // a route with parameters is out of the text test: ":name" would let an earlier regex in
        const regexCanMatch = r.pattern instanceof RegExp && (!withParams || r.use);
        if (
            (regexCanMatch && r.pattern.test(route.path)) ||
            (typeof r.pattern === "string" &&
                (r.pattern === route.path ||
                    (!caseSensitive && r.pattern.toLowerCase() === routePathFolded) ||
                    r.pattern === "/*"))
        ) {
            if (r.callbacks.some((c) => c instanceof Router)) {
                return false;
            }
            optimizedPath.push(r);
            continue;
        }
        // non-strict answers "/x/" too, and an earlier pattern matching only that answers part of
        // what this takes: app.all("/:p0/{:o1}/{:o2}") answered a GET /list/Mixed of the next route
        if (regexCanMatch && !strictHere && r.pattern.test(route.path + "/")) {
            return false;
        }
        if (!withParams) {
            continue;
        }
        // an earlier route answering only some of this one's paths cannot go in the chain
        if (typeof r.path !== "string" || !canBeOptimizedWithParams(r.path)) {
            return false;
        }
        const rPathFolded = caseSensitive ? r.path : r.path.toLowerCase();
        if (!pathsCanOverlap(rPathFolded, routePathFolded, r.use)) {
            continue;
        }
        if (r.use) {
            return false;
        }
        // the same path lands on the same µWS registration, so the earlier route runs from the chain
        if (rPathFolded === routePathFolded) {
            if (r.callbacks.some((c) => c instanceof Router)) {
                return false;
            }
            optimizedPath.push(r);
            continue;
        }
        // otherwise they overlap only where µWS hands the request to the earlier registration
        if (
            !r.optimizedPath ||
            !uwsPrefersEarlier(r.path, route.path) ||
            (!caseSensitive && route.path !== routePathFolded)
        ) {
            return false;
        }
        // in bytes: under insensitive routing "/POSTS" matches no "/posts" registration and lands
        // here, so the literal is remembered and such a request goes to the generic router
        if (!caseSensitive && HAS_LETTER.test(r.path)) {
            (caseGuards ??= []).push(r.path);
        }
    }
    optimizedPath.push(route);
    route._caseGuards = caseGuards;
    route._headGeneric = headGeneric;

    return optimizedPath;
}

/**
 * Whether a HEAD of some path this GET route answers would enter the earlier route of another
 * verb for its param() callbacks: the router has callbacks and the paths can meet. A wrong yes
 * costs the HEAD twin its native registration and nothing else.
 *
 * @param {RouteEntry} r the earlier route, of another verb
 * @param {RouteEntry} route the GET route
 * @param {boolean} caseSensitive
 * @param {boolean} strictHere
 * @returns {boolean}
 */
function headEnters(r, route, caseSensitive, strictHere) {
    if (r.paramCallbacks.size === 0 || typeof route.path !== "string") {
        return false;
    }
    if (!route.path.includes(":")) {
        if (typeof r.pattern === "string") {
            return (
                r.pattern === "/*" ||
                (caseSensitive ? r.pattern === route.path : r.patternLower === route.path.toLowerCase())
            );
        }
        return r.pattern.test(route.path) || (!strictHere && r.pattern.test(route.path + "/"));
    }
    if (typeof r.path !== "string" || !canBeOptimizedWithParams(r.path)) {
        return true;
    }
    return pathsCanOverlap(
        caseSensitive ? r.path : r.path.toLowerCase(),
        caseSensitive ? route.path : route.path.toLowerCase(),
        r.use
    );
}

/**
 * Hands every route reachable by path alone to the native uWS router, walking into mounted
 * routers with their prefix. Runs once, at listen.
 *
 * @param {Router} root the application; a plain router has no uwsApp
 */
function compileOptimizedRoutes(root) {
    if (!root.uwsApp) {
        return;
    }
    // off, every request walks the ordinary chain: `npm run fuzz -- --self` compares the two
    if (root.get("native routes") === false) {
        return;
    }

    // pathPrefix and chainPrefix accumulate across nested mounts, outerGuards carries what was
    // written before them and answers only part of what is under them
    /**
     * @param {Router} router
     * @param {string} pathPrefix
     * @param {RouteEntry[]} chainPrefix
     * @param {import("./router-utils.js").MountGuard[]} outerGuards
     */
    const walk = (router, pathPrefix, chainPrefix, outerGuards) => {
        for (const route of router._routes) {
            if (route.use) {
                // only sole-router mounts; each level's _optimizeRoute guards under its own case setting
                if (
                    !route.complex &&
                    canBeOptimized(route.path) &&
                    route.path !== "/*" &&
                    route.callbacks.length === 1 &&
                    route.callbacks[0] instanceof Router
                ) {
                    let pathToMount = router._optimizeRoute(route, router._routes);
                    if (!pathToMount) {
                        route._whyGeneric = "something before it in the same router overlaps its paths";
                        continue;
                    }
                    pathToMount = pathToMount.slice(0, -1);
                    const guards = guardsInside(router, route, pathPrefix, pathToMount, outerGuards);
                    if (guards === null) {
                        route._whyGeneric = "a path written before it cannot be read segment by segment";
                        continue;
                    }
                    route._walkedInto = true;
                    walk(
                        route.callbacks[0],
                        pathPrefix + route.path,
                        [
                            ...chainPrefix,
                            ...pathToMount,
                            {
                                ...route,
                                callbacks: [],
                                callbackKinds: [],
                                keepMount: true,
                                // a mounted sub-app becomes req.app during its dispatch
                                mountApp:
                                    route.callbacks[0].constructor.name === "Application"
                                        ? route.callbacks[0]
                                        : undefined
                            }
                        ],
                        guards
                    );
                } else {
                    route._whyGeneric = !(route.callbacks.length === 1 && route.callbacks[0] instanceof Router)
                        ? "it is middleware rather than a single mounted router"
                        : "µWS cannot match this mount path on its own";
                }
            } else if (
                (canBeOptimized(route.path) || canBeOptimizedWithParams(route.path)) &&
                // Inside a mounted router, only when nothing after it could answer the same path,
                // literal routes included: uWS picks by specificity, Express by order, so a
                // `get("/a", next())` before `get("/:x")` answered 404. Fuzzer seed 221940161
                (!pathPrefix || !router._isFollowedByAnOverlap(route, router._routes)) &&
                supportedUwsMethods.has(route.method)
            ) {
                // something written before the mount that could answer this path, which µWS
                // would never give its turn
                if (outerGuards.length > 0 && typeof route.path === "string") {
                    const absolute = pathPrefix + route.path;
                    const guard = outerGuards.find((g) => shadowsLeaf(g, absolute, route));
                    if (guard) {
                        route._whyGeneric = `${guard.path} is written before the mount it is in and answers the same paths`;
                        continue;
                    }
                }
                const leafPath = router._optimizeRoute(route, router._routes);
                if (!leafPath) {
                    route._whyGeneric = "something before it in the same router overlaps its paths";
                    continue;
                }
                // a route of another verb before the mount that a HEAD would enter, see headEnters
                if (
                    !route._headGeneric &&
                    route.method === "GET" &&
                    outerGuards.length > 0 &&
                    typeof route.path === "string" &&
                    outerGuards.some((g) => headEntersGuard(g, pathPrefix + route.path))
                ) {
                    route._headGeneric = true;
                }
                // an earlier parameter route in the same router would take this literal path
                if (leafPath.length > 1) {
                    const shadow = leafPath[leafPath.length - 2];
                    if (
                        shadow &&
                        !shadow.use &&
                        shadow.method === route.method &&
                        shadow.path !== route.path &&
                        shadow.pattern instanceof RegExp
                    ) {
                        route._whyGeneric = `the parameter route ${shadow.path} is written before it`;
                        continue;
                    }
                }
                // a pathless mount adds nothing to the path and everything to the chain
                const chain = chainPrefix.length > 0 ? [...chainPrefix, ...leafPath] : leafPath;
                if (pathPrefix) {
                    const registered = {
                        ...route,
                        path: pathPrefix + route.path,
                        pattern: pathPrefix + route.path,
                        optimizedRouter: true
                    };
                    if (route._caseGuards) {
                        // compared against the whole path µWS matched, prefix included
                        registered._caseGuards = route._caseGuards.map((/** @type {string} */ p) => pathPrefix + p);
                    }
                    root._registerUwsRoute(registered, chain);
                    // the chain and the profile hold the original object, not the copy
                    route.optimizedParams = registered.optimizedParams;
                    route.optimizedPath = registered.optimizedPath;
                    route._native = registered._native;
                } else {
                    root._registerUwsRoute(route, chain);
                }
            } else if (!supportedUwsMethods.has(route.method)) {
                route._whyGeneric = `µWS does not serve ${route.method}`;
            } else if (canBeOptimized(route.path) || canBeOptimizedWithParams(route.path)) {
                route._whyGeneric = "a route after it in the same mounted router could answer the same paths";
            } else {
                route._whyGeneric = "µWS cannot match this path on its own";
            }
        }
    };

    walk(root, "", [], []);
}

/**
 * Hands one route to µWS with the chain that runs in front of it.
 *
 * @param {Router} router
 * @param {RouteEntry} route
 * @param {RouteEntry[]} optimizedPath the routes to run, in order, ending with this one
 */
function registerUwsRoute(router, route, optimizedPath) {
    let method = route.method.toLowerCase();
    if (method === "all") {
        method = "any";
    } else if (method === "delete") {
        method = "del";
    }
    if (route.path.includes(":")) {
        route.optimizedParams = route.path.match(regExParam).map((/** @type {string} */ p) => p.slice(1));
    }
    // see _optimizeRoute; matched insensitively, that is the folding the guard exists for
    const caseGuards = route._caseGuards
        ? route._caseGuards.map((/** @type {string} */ p) =>
              needsConversionToRegex(p) ? patternToRegex(p, false, false) : p.toLowerCase()
          )
        : null;
    /**
     * @param {RouteEntry[]} chain
     * @param {import("./router-utils.js").NativePreset|undefined} preset
     * @param {{skipHeaders: boolean, skipQuery: boolean}} skips
     * @param {string|null} wireMethod
     */
    const makeHandler = (chain, preset, skips, wireMethod) => {
        // where a granted skip lives, so a middleware added after listen can take it back: the
        // preset for a literal registration, a holder for a parameterised one
        /** @type {import("./router-utils.js").SkipHolder|undefined} */
        let skipHolder = preset;
        if (skipHolder === undefined && (skips.skipHeaders || skips.skipQuery || wireMethod !== null)) {
            skipHolder = {
                skipHeaders: skips.skipHeaders,
                skipQuery: skips.skipQuery,
                method: wireMethod,
                isOptions: wireMethod === "OPTIONS",
                isHead: wireMethod === "HEAD"
            };
            if (skips.skipHeaders || skips.skipQuery) {
                (router._skipPresets ??= new Set()).add(skipHolder);
            }
        }
        // registration-time constants. Falling back resumes after the mount, not the leaf: an
        // error handler declared before the mount must not catch what the router threw
        const mount = chain.find((r) => r.keepMount);
        const skipUntil = mount ?? chain[chain.length - 1];
        const optimizedParams = route.optimizedParams;
        // no promise pair, nativeDone and nativeFail defer their epilogues to a microtask
        return (res, req) => {
            // an earlier literal in another case is that route's, which this chain lacks
            if (caseGuards !== null && anyGuardHits(caseGuards, req.getUrl())) {
                return /** @type {Application} */ (router)._serveGeneric(res, req);
            }
            const request = router.handleRequest(res, req, preset, skipHolder);
            const response = request.res;
            if (request._mustRefuse === true) {
                return router._refuseRequest(response);
            }
            if (optimizedParams) {
                // slicing them out of the path instead measured a wash
                request.optimizedParams = new NullObject();
                for (let i = 0; i < optimizedParams.length; i++) {
                    request.optimizedParams[optimizedParams[i]] = req.getParameter(i);
                }
            }
            const walk = new Walk(router, request, response, chain, true, skipUntil, nativeDone, nativeFail);
            try {
                walk.dispatch(0);
            } catch (err) {
                nativeFail.call(walk, err);
            } finally {
                // after this line writes are outside uWS's own cork
                response._corkNeeded = true;
                // an abort can only arrive after this callback returns
                if (!response.finished) {
                    router._armAbort(res, response);
                }
            }
        };
    };
    // a HEAD route in a GET route's chain is for the head registration only
    const getChain = route.method === "GET" ? optimizedPath.filter((r) => r.all || r.method !== "HEAD") : optimizedPath;
    route.optimizedPath = optimizedPath;
    const headChain = getChain.length === optimizedPath.length ? getChain : optimizedPath;

    // a literal registration knows path and method, "any" and a parameterised one stay dynamic
    const canPreset = !route.optimizedParams && method !== "any";
    // the route's own router decides: a { strict: true } router on a non-strict app does not answer /things/
    const strictHere = (route.owner ?? router)._strictRouting();

    // Whether this registration may skip the header copy: GET and HEAD only, no error middleware
    // (a throw reaches code the analysis never saw), every callback passing usage.js. The etag
    // setting is not a condition: the skip branch reads the conditional pair by name anyway
    const NO_SKIPS = { skipHeaders: false, skipQuery: false };
    let getSkips = NO_SKIPS;
    let headSkips = NO_SKIPS;
    if (route.method === "GET") {
        let hasErr = router._hasErrMwCache;
        if (hasErr === undefined) {
            hasErr = router._hasErrMwCache = hasErrorMiddleware(router);
        }
        if (!hasErr) {
            // a terminal next() may only fall into the framework's own 404
            const owner = route.owner ?? router;
            const noLaterMatch = !owner._isFollowedByAnOverlap.call(owner, route, owner._routes);
            getSkips = chainUsage(getChain, noLaterMatch);
            headSkips = headChain === getChain ? getSkips : chainUsage(headChain, noLaterMatch);
        }
    }
    /**
     * @param {string} path
     * @param {string} method
     * @param {{skipHeaders: boolean, skipQuery: boolean}} skips
     */
    const makePreset = (path, method, skips) => {
        const preset = nativePreset(path, method);
        if (skips.skipHeaders || skips.skipQuery) {
            preset.skipHeaders = skips.skipHeaders;
            preset.skipQuery = skips.skipQuery;
            (router._skipPresets ??= new Set()).add(preset);
        }
        return preset;
    };

    const wireMethod = method === "any" ? null : route.method;
    let fn = makeHandler(
        getChain,
        canPreset ? makePreset(route.path, route.method, getSkips) : undefined,
        getSkips,
        wireMethod
    );
    const jsFn = fn;

    let replacedPath = route.path;

    // the response prototype the route really runs under, which sees a patched method
    const responseProto = route.owner?.response ?? /** @type {Application} */ (router).response;
    if (
        optimizedPath.length === 1 && // no middleware in front
        route.callbacks.length === 1 &&
        typeof route.callbacks[0] === "function" &&
        route.paramCallbacks.size === 0 && // a param callback has to run
        // a parameter that cannot be decoded is a 400, which nothing runs to raise here
        (route.optimizedParams === undefined || router.get("declarative request values")) &&
        // no javascript runs, so no case guard could
        caseGuards === null &&
        !resDecMethods.some((method) => resCodes[method] !== responseProto[method].toString()) && // no patched methods
        router.get("declarative responses")
    ) {
        const decRes = compileDeclarative(route.callbacks[0], router);
        if (decRes) {
            fn = decRes;
        }
    } else {
        replacedPath = route.path.replace(regExParam, ":x");
    }

    // what listen() settled, for `npx fulmine profile`
    route._native = {
        path: replacedPath,
        declarative: fn !== jsFn,
        skipHeaders: getSkips.skipHeaders === true,
        skipQuery: getSkips.skipQuery === true,
        ahead: optimizedPath.length - 1,
        guards: caseGuards ? caseGuards.length : 0
    };

    router.uwsApp[method](replacedPath, fn);
    if (!strictHere && route.path[route.path.length - 1] !== "/") {
        // a preset handler cannot be shared, the twin's path is its own constant
        const slashFn =
            fn !== jsFn
                ? fn
                : canPreset
                  ? makeHandler(getChain, makePreset(route.path + "/", route.method, getSkips), getSkips, wireMethod)
                  : fn;
        router.uwsApp[method](replacedPath + "/", slashFn);
        if (method === "get" && !route._headGeneric) {
            router.uwsApp.head(
                replacedPath + "/",
                makeHandler(
                    headChain,
                    canPreset ? makePreset(route.path + "/", "HEAD", headSkips) : undefined,
                    headSkips,
                    "HEAD"
                )
            );
        }
    }
    if (method === "get" && !route._headGeneric) {
        // its own handler, the shared one would carry GET
        router.uwsApp.head(
            replacedPath,
            makeHandler(headChain, canPreset ? makePreset(route.path, "HEAD", headSkips) : undefined, headSkips, "HEAD")
        );
    }
}

module.exports = { useRouterClass, optimizeRoute, compileOptimizedRoutes, registerUwsRoute };
