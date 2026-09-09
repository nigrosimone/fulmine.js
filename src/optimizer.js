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
    guardsInside,
    supportedUwsMethods,
    regExParam
} = require("./router-utils.js");

// router.js requires this file while it is still being evaluated, so its class cannot be required
// from here: it hands it over on the line under its own export instead.
let Router;

/**
 * @param {any} cls
 */
function useRouterClass(cls) {
    Router = cls;
}

/**
 * The chain a request would walk to reach this route, or false when it cannot be known ahead of
 * time. The native router jumps straight to the route, so everything registered before it that
 * could also match has to be in the chain, in order.
 *
 * @param {Router} router
 * @param {RouteEntry} route
 * @param {any[]} routes every route of this router, in registration order
 * @returns {any[]|false} the chain, ending in the route itself
 */
function optimizeRoute(router, route, routes) {
    const optimizedPath = [];
    // a route with a parameter matches paths its own text does not, so what an earlier route
    // could answer is compared shape against shape and not against that text
    const withParams = typeof route.path === "string" && route.path.includes(":");
    // under insensitive routing two paths that differ only in case answer the same requests, so
    // the text comparisons below run on the folded form. uWS still matches bytes: a request in the
    // registered case takes the chain, any other case takes the fallback
    const caseSensitive = router._caseSensitive();
    const routePathFolded = caseSensitive || typeof route.path !== "string" ? route.path : route.path.toLowerCase();
    // whether this route answers only the path as written, or the one with a trailing slash too
    const strictHere = (route.owner ?? router)._strictRouting();
    /** @type {string[]|null} earlier literals a case variant could smuggle a request past */
    let caseGuards = null;

    for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        if (r.routeKey > route.routeKey) {
            break;
        }
        if (r === route) {
            continue;
        }
        // if the methods are not the same, and its not an all method, skip it
        if (!r.all && r.method !== route.method) {
            // check if the methods are compatible (GET and HEAD)
            if (!(r.method === "HEAD" && route.method === "GET")) {
                // A mount is registered ALL, because what lives under it can answer any method,
                // and this chain is computed once for all of them. So an earlier route of another
                // method belongs in the chain of the leaves that share its method and in no other,
                // which one chain cannot say: uWS would jump to a leaf as if the earlier route did
                // not exist. Leave the mount to ordinary dispatch, where express's order decides.
                if (route.use && typeof route.path === "string" && couldAnswer(r, route.path)) {
                    return false;
                }
                continue;
            }
        }

        // The same rule as above, reached by another road. A mount's chain is inherited by every
        // path under it, and a route that is not a mount answers the mount point rather than the
        // subtree: in the chain it ran for the whole of it, so router.all("/:p1") answered the
        // /posts/a-b of the router mounted at /posts. guardsInside is written for this.
        if (route.use && !r.use && typeof route.path === "string" && couldAnswer(r, route.path)) {
            return false;
        }

        // a RegExp mount runs only where its match starts the path and breaks on a separator,
        // which is decidable here against a literal path and not against one with a parameter
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
            // it may still answer some of the paths this route matches, and the chain has no
            // way to say "only sometimes"
            if (matched !== null || withParams) {
                return false;
            }
            continue;
        }

        // check if the paths match. A route with parameters is excluded from the text test:
        // its literal ":name" text would let an earlier regex in on requests it never matches.
        const regexCanMatch = r.pattern instanceof RegExp && (!withParams || r.use);
        if (
            (regexCanMatch && r.pattern.test(route.path)) ||
            (typeof r.pattern === "string" &&
                (r.pattern === route.path ||
                    (!caseSensitive && r.pattern.toLowerCase() === routePathFolded) ||
                    r.pattern === "/*"))
        ) {
            if (r.callbacks.some((c) => c instanceof Router)) {
                return false; // cant optimize nested routers with matches
            }
            optimizedPath.push(r);
            continue;
        }
        // Without strict routing this registration answers "/x/" as well as "/x". An earlier
        // pattern matching only the second answers part of what the registration takes, which the
        // chain cannot say: it runs what is in it without matching again. So
        // app.all("/:p0/{:o1}/{:o2}") answered a GET /list/Mixed belonging to the route after it.
        if (regexCanMatch && !strictHere && r.pattern.test(route.path + "/")) {
            return false;
        }
        if (!withParams) {
            continue;
        }
        // an earlier route that answers only some of the paths this one matches cannot go in
        // the chain, which runs what is in it without matching again
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
        // the same path lands on the same µWS registration, so the earlier route runs first
        // from inside the chain, under its own parameter names; a case variant of it lands on
        // its own registration, whose chain was computed the same way, or on the fallback
        if (rPathFolded === routePathFolded) {
            if (r.callbacks.some((c) => c instanceof Router)) {
                return false;
            }
            optimizedPath.push(r);
            continue;
        }
        // otherwise the two overlap only where µWS itself hands the request to the earlier,
        // more specific registration, so this chain never sees those paths
        if (
            !r.optimizedPath ||
            !uwsPrefersEarlier(r.path, route.path) ||
            (!caseSensitive && route.path !== routePathFolded)
        ) {
            return false;
        }
        // that argument is about bytes. Under insensitive routing "/POSTS" byte-matches no
        // registration of "/posts", so uWS hands it here, where this chain would answer as if the
        // earlier route did not exist. The literal is remembered so the registration can send those
        // requests to the generic router. A path with no letter has no other case to arrive in
        if (!caseSensitive && HAS_LETTER.test(r.path)) {
            (caseGuards ??= []).push(r.path);
        }
    }
    optimizedPath.push(route);
    route._caseGuards = caseGuards;

    return optimizedPath;
}

/**
 * Hands every route reachable by path alone to the native uWS router, walking into mounted
 * routers and carrying their prefix down. Runs once, when the app starts listening, since it
 * needs every route to have been registered first.
 *
 * @param {any} root
 */
function compileOptimizedRoutes(root) {
    if (!root.uwsApp) {
        return;
    }
    // Everything below is what makes this framework fast, and every decision it takes claims that
    // uWS answering by itself gives the same answer the chain would. Turned off, the claim is not
    // made. `npm run fuzz -- --self` serves one application both ways and compares the answers.
    if (root.get("native routes") === false) {
        return;
    }

    // pathPrefix/chainPrefix accumulate across nested sole-callback mounts, and outerGuards
    // carries what was written before them and answers only part of what is under them
    const walk = (router, pathPrefix, chainPrefix, outerGuards) => {
        for (const route of router._routes) {
            if (route.use) {
                // only sole-callback mounts. Case rules do not gate the walk: each level's
                // _optimizeRoute guards its own routes under its own setting, and a request in
                // another case takes the fallback, which honours the child's setting
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
                                // mounted sub-apps become req.app during their dispatch, like express
                                mountApp:
                                    route.callbacks[0].constructor.name === "Application"
                                        ? route.callbacks[0]
                                        : undefined
                            }
                        ],
                        guards
                    );
                } else {
                    // said once here rather than at each condition above: a mount is walked into
                    // only when µWS can match its path on its own and it carries exactly one
                    // router, and those are the two things worth telling anyone about
                    route._whyGeneric = !(route.callbacks.length === 1 && route.callbacks[0] instanceof Router)
                        ? "it is middleware rather than a single mounted router"
                        : "µWS cannot match this mount path on its own";
                }
                // µWS picks by specificity and Express by registration order, so the chain
                // computed for whichever route µWS lands on runs everything that could have
                // matched before it
            } else if (
                // parameters that are whole segments are matched by µWS the same way
                (canBeOptimized(route.path) || canBeOptimizedWithParams(route.path)) &&
                // Inside a mounted router, only when nothing after it could answer the same path.
                // Asked of literal routes too, not only parameter ones: uWS picks by specificity
                // where Express picks by registration order, and a chain carries only what runs in
                // front of its route, so `router.get("/a", (req, res, next) => next())` before
                // `router.get("/:x", ...)` left the mount and answered 404. Found by the fuzzer,
                // replay with --seed 221940161 --rounds 1.
                (!pathPrefix || !router._isFollowedByAnOverlap(route, router._routes)) &&
                supportedUwsMethods.has(route.method)
            ) {
                // something outside this router, written before the mount it is in, that could
                // answer this exact path. µWS would jump here and never give it its turn
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
                // param route earlier in the same router would steal this static path
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
                // the prefix goes in whether or not the mount had a path: a pathless mount
                // adds nothing to the path and everything to the chain, the middlewares in
                // front of it and the mount entry that says where to resume
                const chain = chainPrefix.length > 0 ? [...chainPrefix, ...leafPath] : leafPath;
                if (pathPrefix) {
                    const registered = {
                        ...route,
                        path: pathPrefix + route.path,
                        pattern: pathPrefix + route.path,
                        optimizedRouter: true
                    };
                    if (route._caseGuards) {
                        // compared against the whole path µWS matched, so they carry the mount
                        // prefix, folded along with the rest of it
                        registered._caseGuards = route._caseGuards.map((p) => pathPrefix + p);
                    }
                    root._registerUwsRoute(registered, chain);
                    // the chain holds the original object, so the request-time guard has to find
                    // the computed fields there, or a mounted param route extracts its params
                    // twice. The names match: the prefix is static and adds no parameter
                    route.optimizedParams = registered.optimizedParams;
                    route.optimizedPath = registered.optimizedPath;
                    // and what was decided about it, for the same reason: the copy is thrown
                    // away and the profile reads the route the application actually holds
                    route._native = registered._native;
                } else {
                    root._registerUwsRoute(route, chain);
                }
            } else if (!supportedUwsMethods.has(route.method)) {
                route._whyGeneric = `µWS does not serve ${route.method}`;
            } else if (canBeOptimized(route.path) || canBeOptimizedWithParams(route.path)) {
                // eligible but for the overlap test, which only applies inside a mount
                route._whyGeneric = "a route after it in the same mounted router could answer the same paths";
            } else {
                route._whyGeneric = "µWS cannot match this path on its own";
            }
        }
    };

    walk(root, "", [], []);
}

/**
 * Hands one route to µWS, along with the chain of everything that has to run in front of it,
 * and records that chain on the route so the handler can walk it.
 *
 * @param {Router} router
 * @param {RouteEntry} route
 * @param {any[]} optimizedPath the routes to run, in order, ending with this one
 */
function registerUwsRoute(router, route, optimizedPath) {
    let method = route.method.toLowerCase();
    if (method === "all") {
        method = "any";
    } else if (method === "delete") {
        method = "del";
    }
    if (route.path.includes(":")) {
        route.optimizedParams = route.path.match(regExParam).map((p) => p.slice(1));
    }
    // null for almost every route: only a parameter route with an earlier literal that a case
    // variant could slip past carries one, see _optimizeRoute. Built once here, and matched
    // insensitively, since that is the folding the guard exists for
    const caseGuards = route._caseGuards
        ? route._caseGuards.map((p) => (needsConversionToRegex(p) ? patternToRegex(p, false, false) : p.toLowerCase()))
        : null;
    const makeHandler = (chain, preset, skips, wireMethod) => {
        // the mutable object a granted skip lives on, so a middleware arriving after listen can
        // take it back: a literal registration's preset doubles as it, a parameterised one gets a
        // holder of its own. It carries the method too, so the constructor settles it in one compare
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
        // all three are registration-time constants: computing them in the handler was a
        // closure and a scan of the chain on every native request.
        // Falling back resumes after the mount, not after the router's leaf: the leaf can have
        // a lower routeKey than the parent's middlewares, and an error handler declared before
        // the mount must not catch what the router threw
        const mount = chain.find((r) => r.keepMount);
        const skipUntil = mount ?? chain[chain.length - 1];
        const optimizedParams = route.optimizedParams;
        // not async, and no _routeRequest: its promise pair exists for callers that await,
        // and this one never did. nativeDone and nativeFail defer their epilogues to a
        // microtask, which is where the await used to resume, so the visible order holds
        return (res, req) => {
            // a request that is an earlier literal in another case: express answers it with
            // that route, and the chain here does not contain it, so the generic router takes
            // this one
            if (caseGuards !== null && anyGuardHits(caseGuards, req.getUrl())) {
                // an application is what registers native routes, and only it serves
                return /** @type {any} */ (router)._serveGeneric(res, req);
            }
            const request = router.handleRequest(res, req, preset, skipHolder);
            const response = request.res;
            if (request._mustRefuse === true) {
                return router._refuseRequest(response);
            }
            if (optimizedParams) {
                // slicing these out of the already-fetched path instead measured a wash:
                // the segment scan costs what the crossing costs
                request.optimizedParams = new NullObject();
                for (let i = 0; i < optimizedParams.length; i++) {
                    request.optimizedParams[optimizedParams[i]] = req.getParameter(i);
                }
            }
            const walk = new Walk(router, request, response, chain, true, skipUntil, nativeDone, nativeFail);
            try {
                walk.dispatch(0);
            } catch (err) {
                // what a throw inside a promise executor did: reject, once
                nativeFail.call(walk, err);
            } finally {
                // whatever runs after this line is outside the cork uWS held for this
                // callback, so later writes have to open their own
                response._corkNeeded = true;
                // an abort can only arrive after this callback returns, so a response that
                // already finished inside it never needs uWS told at all
                if (!response.finished) {
                    router._armAbort(res, response);
                }
            }
        };
    };
    // a HEAD route may sit in a GET route's chain so the head registration runs it, but a
    // chain runs without re-matching the method, so the get registration must not see it
    const getChain = route.method === "GET" ? optimizedPath.filter((r) => r.all || r.method !== "HEAD") : optimizedPath;
    route.optimizedPath = optimizedPath;
    const headChain = getChain.length === optimizedPath.length ? getChain : optimizedPath;

    // A fully literal registration knows path and method here, so each registration site
    // hands the request constructor its own constants. An "any" registration serves every
    // verb and a parameterised one matches paths it cannot spell, so both stay dynamic
    const canPreset = !route.optimizedParams && method !== "any";
    // the route's own router decides, not the app running the registration: a router created
    // with { strict: true } and mounted on an app without it does not answer /things/, and
    // registering that path here is the only way it could
    const strictHere = (route.owner ?? router)._strictRouting();

    // Whether requests served by this registration may skip the header copy: GET and its HEAD twins
    // only, no error middleware anywhere (a throw hands the request to code the analysis never
    // saw), and every callback in the chain has to pass usage.js, whose default answer is no.
    //
    // The etag setting is not a condition. It used to be, because send consults freshness, but the
    // skip branch reads if-none-match and if-modified-since by name whatever the setting, see the
    // comment in request.js, and req.fresh reads nothing else. Requiring etag off as well cost the
    // copy to every application that left it on.
    const NO_SKIPS = { skipHeaders: false, skipQuery: false };
    let getSkips = NO_SKIPS;
    let headSkips = NO_SKIPS;
    if (route.method === "GET") {
        let hasErr = router._hasErrMwCache;
        if (hasErr === undefined) {
            hasErr = router._hasErrMwCache = hasErrorMiddleware(router);
        }
        if (!hasErr) {
            // a terminal next() may only fall into the framework's own 404, so no later
            // route may be able to catch the same path
            const owner = route.owner ?? router;
            const noLaterMatch = !owner._isFollowedByAnOverlap.call(owner, route, owner._routes);
            getSkips = chainUsage(getChain, noLaterMatch);
            headSkips = headChain === getChain ? getSkips : chainUsage(headChain, noLaterMatch);
        }
    }
    // remembered so a middleware or setting arriving after listen can take the skips back
    const makePreset = (path, method, skips) => {
        const preset = nativePreset(path, method);
        if (skips.skipHeaders || skips.skipQuery) {
            preset.skipHeaders = skips.skipHeaders;
            preset.skipQuery = skips.skipQuery;
            (router._skipPresets ??= new Set()).add(preset);
        }
        return preset;
    };

    // the wire token this registration answers; "any" serves every verb and stays dynamic
    const wireMethod = method === "any" ? null : route.method;
    let fn = makeHandler(
        getChain,
        canPreset ? makePreset(route.path, route.method, getSkips) : undefined,
        getSkips,
        wireMethod
    );
    const jsFn = fn;

    let replacedPath = route.path;

    // the response prototype the route will really run under: its own app's, which sees a
    // method patched there or inherited from a parent app, falling back to the registering app
    const responseProto = /** @type {any} */ (route.owner)?.response ?? /** @type {any} */ (router).response;
    // check if route is declarative
    if (
        optimizedPath.length === 1 && // must not have middlewares
        route.callbacks.length === 1 && // must not have multiple callbacks
        typeof route.callbacks[0] === "function" && // must be a function
        route.paramCallbacks.size === 0 && // a param callback has to run, and this answers without running anything
        // a captured value is decoded when the route runs, and one that cannot be decoded is a
        // 400 in express and on the ordinary path here. Nothing runs to raise it on a
        // declarative response, so GET /a-b%5Ec@d%e came back 200 from app.get("/:p12")
        route.optimizedParams === undefined &&
        // a declarative response is answered by µWS itself, so no javascript runs and the case
        // guard could not: a route that needs one has to stay an ordinary handler
        caseGuards === null &&
        !resDecMethods.some((method) => resCodes[method] !== responseProto[method].toString()) && // must not have injected methods
        router.get("declarative responses") // must have declarative responses enabled
    ) {
        const decRes = compileDeclarative(route.callbacks[0], router);
        if (decRes) {
            fn = decRes;
        }
    } else {
        replacedPath = route.path.replace(regExParam, ":x");
    }

    // what listen() settled about this route, kept so `npx fulmine profile` can print it rather
    // than making anyone read the source or instrument it. Written once, during compilation,
    // so no request pays for it
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
        // a declarative response answers the twin as itself; a preset handler cannot be
        // shared, since the twin's path is its own constant
        const slashFn =
            fn !== jsFn
                ? fn
                : canPreset
                  ? makeHandler(getChain, makePreset(route.path + "/", route.method, getSkips), getSkips, wireMethod)
                  : fn;
        router.uwsApp[method](replacedPath + "/", slashFn);
        if (method === "get") {
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
    if (method === "get") {
        // its own handler always: the shared one would carry the GET registration's method
        router.uwsApp.head(
            replacedPath,
            makeHandler(headChain, canPreset ? makePreset(route.path, "HEAD", headSkips) : undefined, headSkips, "HEAD")
        );
    }
}

module.exports = { useRouterClass, optimizeRoute, compileOptimizedRoutes, registerUwsRoute };
