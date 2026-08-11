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

const {
    patternToRegex,
    getPatternMeta,
    decodeParam,
    needsConversionToRegex,
    canBeOptimized,
    canBeOptimizedWithParams,
    pathsCanOverlap,
    uwsPrefersEarlier,
    regexpGroupKeys,
    NullObject,
    EMPTY_REGEX
} = require("./utils.js");
const Response = require("./response.js");
const Request = require("./request.js");
const { EventEmitter } = require("tseep");
const compileDeclarative = require("./declarative.js");
const statuses = require("statuses");
const { METHODS } = require("http");
const { isNodeRequest, serveNodeRequest } = require("./node-shim.js");
const { chainUsage, kGetSafe } = require("./usage.js");
const { checkBehavior } = require("./websocket.js");

// whether a registered path could be asked for in another case, which is what decides whether the
// native router can be trusted to prefer it, see _optimizeRoute
const HAS_LETTER = /[a-zA-Z]/;

// hands out one number per app.route(), so the routes it creates know they belong together
let routeGroups = 0;

/**
 * Whether an earlier route would have answered this path had case not mattered. A guard is a
 * folded string when the earlier path is a literal, and an insensitive pattern when it has
 * parameters of its own.
 *
 * The string side is compared character by character rather than through toLowerCase, because it
 * sits on the hot path of every parameter route that has an earlier literal, and saying no must
 * allocate nothing.
 *
 * @param {(string|RegExp)[]} guards
 * @param {string} path the path as it arrived
 * @returns {boolean}
 */
function anyGuardHits(guards, path) {
    for (let i = 0; i < guards.length; i++) {
        const guard = guards[i];
        if (typeof guard !== "string") {
            if (guard.test(path)) {
                return true;
            }
            continue;
        }
        // the guard is a registered path, which under the default routing answers the same path
        // with one trailing slash as well: "/x1" registered is what serves "/x1/", so "/X1/" is
        // just as much a case variant of it as "/X1" is. Missing that answered "/X1/" from the
        // parameter route behind it while express answered from the literal.
        //
        // The regex guards, for earlier paths that carry parameters of their own, are built
        // non-strict and already accept it. Erring wide costs nothing here either: a guard that
        // hits only hands the request to the generic router, which is where express's own order
        // decides anyway
        const slashed = path.length === guard.length + 1 && path.charCodeAt(guard.length) === 0x2f;
        if (guard.length !== path.length && !slashed) {
            continue;
        }
        let same = true;
        for (let j = 0; j < guard.length; j++) {
            let code = path.charCodeAt(j);
            // A to Z only, which is the fold express's insensitive routing does
            if (code >= 65 && code <= 90) {
                code += 32;
            }
            if (code !== guard.charCodeAt(j)) {
                same = false;
                break;
            }
        }
        if (same) {
            return true;
        }
    }
    return false;
}

// every method the declarative compiler can emit: a patched one must disable compilation, or the
// patch would be honoured everywhere but on compiled routes
const resCodes = {},
    resDecMethods = ["set", "setHeader", "header", "send", "end", "append", "status", "json", "sendStatus"];
for (const method of resDecMethods) {
    resCodes[method] = Response.prototype[method].toString();
}

let routeKey = 0;

/**
 * One walk of one router's routes, for one request.
 *
 * next() is made once here instead of once per hop. As a closure per hop it captured eleven
 * bindings, one of them mutable, which is a context on the heap every time a middleware hands over.
 * The hop's own state is three fields on this instead.
 *
 * A nested router gets its own walk, through its own _routeRequest, so req.next belongs to whoever
 * is running the request at that moment.
 */
class Walk {
    /**
     * @param {any} router
     * @param {any} req
     * @param {any} res
     * @param {any[]} routes
     * @param {boolean} skipCheck take the route at the index without matching it, which is how an
     *   already-decided chain is walked
     * @param {any} skipUntil route to resume after when this chain runs out, or undefined
     * @param {(value: any) => void} resolve
     * @param {(err: any) => void} reject
     */
    constructor(router, req, res, routes, skipCheck, skipUntil, resolve, reject) {
        this.router = router;
        this.req = req;
        this.res = res;
        this.routes = routes;
        this.skipCheck = skipCheck;
        this.skipUntil = skipUntil;
        this.resolve = resolve;
        this.reject = reject;
        // read only by the native pair below, which has no promise to settle once for it; the
        // promise path leaves it false. Initialized here to keep every walk the same shape
        this.settled = false;
        this.routeIndex = 0;
        this.route = null;
        this.callbackIndex = 0;
        // bound, not wrapped in an arrow: an arrow forwarding into step() is one more call on every
        // hop, and it measured 495 microseconds per thousand requests of nothing else
        this.next = this.step.bind(this);
        // What res.sendFile reports a failure to. Express hands it req.next, which is the router
        // next and not the route one, so a file that cannot be served leaves the route and its
        // error reaches the router error handlers rather than a four argument handler written
        // inside the route. req.next itself is left alone: making it mean this everywhere is what
        // express does, and it breaks express own res.format and app.routes.error tests here, so
        // that stays open rather than half done.
        this.leaveRoute = this.stepOutOfRoute.bind(this);
    }

    /**
     * Leaves the rest of this route, with the error if there is one, and carries on with the route
     * after it.
     *
     * @param {any} [err]
     */
    stepOutOfRoute(err) {
        if (err) {
            const req = this.req;
            req._error = err;
            req._errorKey = this.route.routeKey;
            req._errorGroup = this.route.group;
        }
        this.step("route");
    }

    /**
     * Finds the next route that matches and runs it. next() comes back here for the route after, so
     * a chain of N middlewares costs one promise instead of N nested ones.
     *
     * @param {number} startIndex where to resume the scan
     */
    dispatch(startIndex) {
        const req = this.req;
        const routes = this.routes;
        const router = this.router;
        // a middleware assigned req.url, which express honours: the rest of the walk matches the
        // new path. One identity compare per hop, since the router writes both sides itself; the
        // handling lives out of line so this function stays small enough to inline
        if (req.url !== req._lastUrl && this.takeUrlRewrite(startIndex)) {
            return;
        }
        let routeIndex = startIndex;
        // a compiled chain runs what is in it without matching again, so this is where a layer that
        // provably has nothing to do for this request is stepped over rather than entered
        if (this.skipCheck) {
            while (routeIndex < routes.length && routes[routeIndex].bodyParserOnly === true) {
                if (!stepsOver(routes[routeIndex], req)) {
                    break;
                }
                routeIndex++;
            }
        }
        if (!this.skipCheck) {
            // express matches a layer's path before it looks at the method, and decodes the
            // parameters there, so a malformed escape answers 400 even when no route of this
            // method exists. Only a path carrying a percent can produce one, and that check keeps
            // every other request from matching routes it could never run
            const mayFailDecode = req._originalPath.indexOf("%") !== -1;
            // written out rather than through a predicate handed to findIndexStartingFrom, which
            // was one closure per hop of every request not on a compiled chain
            for (; routeIndex < routes.length; routeIndex++) {
                const r = routes[routeIndex];
                if (!(r.all || r.method === req.method || req._isOptions || (r.gettable && req._isHead))) {
                    // taken only to fail: _preprocessRequest decodes again and turns it into the
                    // error, so the handlers of a route this request cannot run never see it
                    if (mayFailDecode && router._pathMatches(r, req) && router._paramsFailToDecode(r, req)) {
                        break;
                    }
                    continue;
                }
                if (router._pathMatches(r, req)) {
                    // matched, and then stepped over: a body parser this request gets nothing out
                    // of costs a hop and answers with next() at the end of it
                    if (r.bodyParserOnly === true && stepsOver(r, req)) {
                        continue;
                    }
                    break;
                }
            }
        }
        const route = routes[routeIndex];
        if (!route) {
            if (!this.skipCheck) {
                // on normal unoptimized routes, if theres no match then there is no route
                return this.resolve(false);
            }
            // the chain ran out, so ordinary routing takes over from the top and skips what has
            // already run
            useApp(req, router);
            // a chain that went into a mount never left it, since keepMount stops the pop, so the
            // path is still relative to it. /alone/skip must not be offered to the app as /skip
            if (req._stack !== null && req._stack.length > 0) {
                req._stack.length = 0;
                req._consumed = 0;
                setMountedPath(req);
            }
            // an error out of a mount is attributed to the mount, so error handlers declared before
            // it do not catch it, as in ordinary dispatch
            if (req._error && this.skipUntil && this.skipUntil.keepMount && this.skipUntil.routeKey > req._errorKey) {
                req._errorKey = this.skipUntil.routeKey;
                req._errorGroup = this.skipUntil.group;
            }
            this.routes = router._routes;
            this.skipCheck = false;
            return this.dispatch(0);
        }

        this.routeIndex = routeIndex;
        this.route = route;
        this.callbackIndex = 0;

        // _preprocessRequest returns a promise only when param callbacks will really run, so the
        // common case stays synchronous even in an app that uses app.param. A microtask every 300
        // routes resets the stack, which a long chain would otherwise blow
        const continueRoute = router._preprocessRequest(req, this.res, route);
        if (continueRoute instanceof Promise || req.routeCount % 300 === 0) {
            // .catch and not a rejection argument: a throw inside runRoute itself must reject
            // the walk instead of becoming an unhandled rejection
            Promise.resolve(continueRoute)
                .then((resumed) => this.runRoute(resumed))
                // wrapped so the native pair keeps the walk as receiver; a promise's reject
                // would not have cared
                .catch((err) => this.reject(err));
            return;
        }
        return this.runRoute(continueRoute);
    }

    /**
     * Takes over a req.url a middleware assigned. On an ordinary walk the scan simply continues
     * against the new path; a compiled chain was computed for the old one, so ordinary routing
     * takes over, skipping only what has already run.
     *
     * @param {number} startIndex where dispatch was about to resume
     * @returns {boolean} whether this rerouted the walk itself
     */
    takeUrlRewrite(startIndex) {
        const req = this.req;
        const router = this.router;
        req._absorbUrlRewrite();
        if (!this.skipCheck) {
            return false;
        }
        this.skipUntil = startIndex > 0 ? this.routes[startIndex - 1] : undefined;
        if (req._stack !== null && req._stack.length > 0) {
            req._stack.length = 0;
            req._consumed = 0;
            setMountedPath(req);
        }
        this.routes = router._routes;
        this.skipCheck = false;
        this.dispatch(0);
        return true;
    }

    /**
     * Enters the route the walk is on: a mount adjusts req.url, req.path and the mount stack on the
     * way in, and then the route's callbacks run one after another through next().
     *
     * @param {any} continueRoute what _preprocessRequest decided: true to run, "route" to skip
     */
    runRoute(continueRoute) {
        const req = this.req;
        const route = this.route;
        if (route.use) {
            if (route.mountApp) {
                // optimized chain: normal dispatch swaps req.app when it enters a mounted
                // Application, but the compiled mount route has no callback to do it
                rememberApp(this, route, req);
                useApp(req, route.mountApp);
            }
            const taken = mountPrefixLength(route, req);
            (req._stack ??= []).push(taken);
            // a use with no path consumes nothing, so everything below would work out the values
            // that are already there. Only skipped without a trailing slash, where the rules about
            // one cannot bite. An application is mostly pathless middleware, and this is per hop
            if (taken !== 0 || req.endsWithSlash) {
                req._consumed += taken;
                setMountedPath(req);
            }
        }
        req.next = this.next;
        // the same step when the route has one callback, and then it has to be the same object:
        // express hands res.format's handlers the next its own layer received, and its test asserts
        // that identity. With more than one callback the two differ for real, and what express
        // hands over is the one that leaves the route
        req._leaveRoute = route.callbacks.length > 1 ? this.leaveRoute : this.next;
        if (continueRoute === "route") {
            this.step("route");
        } else if (continueRoute) {
            this.step(undefined);
        } else {
            this.resolve(true);
        }
    }

    /**
     * A hop while the request carries an error, or over an error handler it cannot run: the
     * handler is invoked when the error is its to catch, everything else is skipped.
     *
     * @param {number} kind what the callback is, one of the CALLBACK_ constants
     * @param {Function} callback
     */
    errorHop(kind, callback) {
        const req = this.req;
        const route = this.route;
        // A four argument handler written inside a route only ever sees what that route raised:
        // express skips a route layer entirely while an error is in flight, so an error from a
        // middleware before it, or out of a mount, walks past to the router's own error handlers.
        // Middleware error handlers keep the ordinary rule, which is that they catch what was
        // raised before them.
        const reachable = route.use
            ? route.routeKey >= req._errorKey
            : route.routeKey === req._errorKey || (route.group !== undefined && route.group === req._errorGroup);
        if (req._error && kind === CALLBACK_ERROR && reachable) {
            const out = this.router._handleError(req._error, callback, req, this.res);
            if (out instanceof Promise) {
                // an error handler's rejected promise moves on to the next error handler, and
                // a bare rejection gets the error express invents for it
                out.catch((err) => {
                    req._error = err || new Error("Rejected promise");
                    req._errorKey = route.routeKey;
                    req._errorGroup = route.group;
                    return this.step(undefined);
                });
            }
            return;
        }
        return this.step(undefined);
    }

    /**
     * One hop, which is what next() does: with nothing, run the route's next callback; with "route",
     * leave the route; with anything else, remember it as the error and carry on.
     *
     * @param {any} thingamabob
     */
    step(thingamabob) {
        const req = this.req;
        const res = this.res;
        const route = this.route;
        const router = this.router;
        if (thingamabob) {
            if (thingamabob === "route" || thingamabob === "router") {
                if (route.use && !route.keepMount) {
                    // a rewrite done inside this middleware is taken now: the pop below recomputes
                    // req.url from the original path and would silently revert it
                    if (req.url !== req._lastUrl) {
                        req._absorbUrlRewrite();
                    }
                    req._consumed -= req._stack.pop();
                    setMountedPath(req);
                    restoreApp(route, req);
                }
                if (thingamabob === "router") {
                    if (this.skipCheck) {
                        // on a compiled chain, leaving the router is what running out of chain
                        // already means: ordinary routing takes over after the mount. With no
                        // mount in the chain the router being left is the app's own, and nothing
                        // of it may run afterwards, not even a middleware registered later
                        if (this.skipUntil?.keepMount) {
                            return this.dispatch(this.routes.length);
                        }
                        return this.resolve(false);
                    }
                    // out of this router entirely, so whoever mounted it carries on after the
                    // mount. The app's own walk has nobody after it, and answers 404
                    return this.resolve(false);
                }
                req.routeCount++;
                // dispatch is a plain call, so a synchronous throw would escape here instead of
                // rejecting, as it used to when this recursed through the async _routeRequest
                try {
                    return this.dispatch(this.routeIndex + 1);
                } catch (err) {
                    return this.reject(err);
                }
            } else {
                req._error = thingamabob;
                req._errorKey = route.routeKey;
                req._errorGroup = route.group;
            }
        }
        const kind = route.callbackKinds[this.callbackIndex];
        const callback = route.callbacks[this.callbackIndex++];
        if (!callback) {
            return this.step("route");
        }
        // skipping routes we already went through via optimized path. Before the Router branch
        // below and not after it: a mount whose chain was compiled has already run, and running it
        // again would answer from inside the router a request that had just left it
        if (!this.skipCheck && this.skipUntil && this.skipUntil.routeKey >= route.routeKey) {
            return this.step(undefined);
        }
        if (kind === CALLBACK_ROUTER) {
            if (callback.constructor.name === "Application") {
                rememberApp(this, route, req);
                useApp(req, callback);
            }
            const pushedParams = callback.settings.mergeParams;
            if (pushedParams) {
                (req._paramStack ??= []).push(req.params);
            }
            // express restores req.params when a router hands back, so what runs after the mount
            // sees the params it had before it
            const parentParams = req.params;
            // each router answers OPTIONS with the verbs it knows itself, so the one being entered
            // starts its own list: express keeps that list per router, and a router that hands back
            // without answering leaves the outer one's untouched
            const parentMethods = req._matchedMethods;
            if (parentMethods !== null) {
                req._matchedMethods = new Set();
            }
            callback
                ._routeRequest(req, res, 0)
                .then((routed) => {
                    // the child's params are scoped to it, and must not leak into the routes after
                    if (pushedParams) {
                        req._paramStack.pop();
                    }
                    req.params = parentParams;
                    if (req._error) {
                        req._errorKey = route.routeKey;
                        req._errorGroup = route.group;
                    }
                    if (routed) {
                        if (parentMethods !== null) {
                            req._matchedMethods = parentMethods;
                        }
                        return this.resolve(true);
                    }
                    const childMethods = req._matchedMethods;
                    if (parentMethods !== null) {
                        req._matchedMethods = parentMethods;
                    }
                    if (req._isOptions && childMethods.size) {
                        // OPTIONS routing is different, it stops in the router if matched.
                        // Express answers as the router hands back, so a throw while answering,
                        // a head already written being the way, walks on to later error handlers
                        if (!req._error) {
                            try {
                                router._sendOptionsReply(req, res, childMethods);
                                return this.resolve(true);
                            } catch (err) {
                                return this.step(err);
                            }
                        }
                        return this.resolve(false);
                    }
                    this.step(undefined);
                })
                // a rejection out of the nested walk, or a throw above, must reject this one
                // instead of dying as an unhandled rejection; wrapped for the native pair's
                // receiver
                .catch((err) => this.reject(err));
        } else {
            // errors and error handlers live out of line: this is the cold path, and its size
            // was pushing step past the inlining threshold
            if (req._error || kind === CALLBACK_ERROR) {
                return this.errorHop(kind, callback);
            }

            try {
                // handling OPTIONS method
                if (req._isOptions && !route.all && route.method !== "OPTIONS") {
                    req._matchedMethods.add(route.method);
                    if (route.gettable) {
                        req._matchedMethods.add("HEAD");
                    }
                    return this.step(undefined);
                }

                const out = callback(req, res, this.next);
                if (out instanceof Promise) {
                    // Express 5 forwards a rejected handler promise to the error middleware on its
                    // own, so there is nothing left for the "catch async errors" setting or for
                    // express-async-errors to opt into. A bare rejection carries no error, and
                    // express invents this one for it
                    out.catch((err) => {
                        req._error = err || new Error("Rejected promise");
                        req._errorKey = route.routeKey;
                        req._errorGroup = route.group;
                        return this.step(undefined);
                    });
                }
            } catch (err) {
                req._error = err;
                req._errorKey = route.routeKey;
                req._errorGroup = route.group;
                return this.step(undefined);
            }
        }
    }
}

/**
 * The native handler's resolve, invoked as this.resolve(matched) with the walk as receiver. The
 * promise pair _routeRequest allocates exists for callers that await; the uWS handler never did,
 * and on the common path, where the handler answers and next() is never called, that promise
 * never even settled: an async frame and two promises of floating garbage per request.
 *
 * The 404 epilogue stays on a microtask, exactly where the await used to resume: a middleware
 * that writes after calling next() must still win the headersSent check, as it does in express.
 * @this {Walk}
 */
function nativeDone(matched) {
    if (this.settled) {
        return;
    }
    this.settled = true;
    if (!matched) {
        queueMicrotask(() => {
            const response = this.res;
            if (response.headersSent || response.aborted) {
                return;
            }
            try {
                this.router._endUnmatched(this.req, response);
            } catch (err) {
                if (response.aborted || response.finished) {
                    console.error(err);
                } else {
                    this.router._handleError(err, null, this.req, response);
                }
            }
        });
    }
}

/**
 * The native handler's reject: answers 500 as express's final handler would, instead of dying as
 * an unhandled rejection. Deferred like the resolve, since every rejection used to reach the
 * handler's catch through an await.
 * @this {Walk}
 */
function nativeFail(err) {
    if (this.settled) {
        return;
    }
    this.settled = true;
    queueMicrotask(() => {
        const response = this.res;
        if (response.aborted || response.finished) {
            console.error(err);
        } else {
            this.router._handleError(err, null, this.req, response);
        }
    });
}

/**
 * How much of the path a mount takes, which is what its own pattern matched and never more than
 * there is. Exec runs on the same fixed-up path _pathMatches tested: a parent mount that consumed
 * everything leaves "", where the pattern was matched against "/".
 *
 * Counting what each mount took, rather than rebuilding one pattern out of the whole stack and
 * matching that against the original path, is the difference between a sum and a guess: a mount
 * written as an optional group composes into a pattern the path no longer satisfies, and the
 * prefix stayed on.
 *
 * @param {any} route
 * @param {any} req
 * @returns {number}
 */
function mountPrefixLength(route, req) {
    // a use with no path is EMPTY_REGEX, which matches "" at 0 whatever the path is. Answered
    // without the exec, since this runs per hop and most middleware is pathless
    if (route.pattern === EMPTY_REGEX) {
        return 0;
    }
    if (typeof route.pattern === "string") {
        return route.pattern.length;
    }
    const path = req._opPath;
    const matched = route.pattern.exec(path === "" ? "/" : path);
    return matched ? Math.min(matched[0].length, path.length) : 0;
}

/**
 * Writes the path the routes below a mount see: the original with what the mounts took off the
 * front. The root reads as "/" rather than as nothing, which is how express hands it over.
 *
 * @param {any} req
 */
function setMountedPath(req) {
    req._opPath = req._consumed === 0 ? req._originalPath : req._originalPath.slice(req._consumed);
    req.url = req._opPath === "" ? "/" + req.urlQuery : req._opPath + req.urlQuery;
    req.path = req._opPath === "" ? "/" : req._opPath;
    req._lastUrl = req.url;
}

/**
 * The route's own params merged with those of the mounts it sits under, in express's order: an
 * outer mount first, the route's own last. Numbered captures do not overwrite each other, they
 * shift, so a RegExp mount capturing one group leaves the route's own group numbered from one.
 *
 * @param {Record<string, any>} own what this route's own pattern captured
 * @param {Record<string, any>[]} stack the mounts, outermost first
 * @returns {Record<string, any>}
 */
/**
 * Whether this route reads the parameters of the mounts above it, which is its own router asking
 * for them. The stack holds what a mergeParams router captured on the way in, and a plain router
 * mounted inside one must not read it: express asks each router in turn, not the outermost.
 *
 * @param {any} route
 * @param {any} fallback the router dispatching, when the route names no owner
 * @returns {boolean}
 */
function mergesParams(route, fallback) {
    const owner = route.owner ?? fallback;
    return Boolean(owner?.settings?.mergeParams);
}

/**
 * The route's own params merged with those of the mounts it sits under, in express's order: an
 * outer mount first, the route's own last. Numbered captures do not overwrite each other, they
 * shift, so a RegExp mount capturing one group leaves the route's own group numbered from one.
 *
 * @param {Record<string, any>} own what this route's own pattern captured
 * @param {Record<string, any>[]} stack the mounts, outermost first
 * @returns {Record<string, any>}
 */
function mergeParams(own, stack) {
    const merged = Object.create(null);
    for (const params of stack) {
        Object.assign(merged, params);
    }
    // both sides numbering from zero means the outer ones keep their places and these move up
    if (own[0] !== undefined && merged[0] !== undefined) {
        let count = 0;
        while (merged[count] !== undefined) {
            count++;
        }
        let last = 0;
        while (own[last] !== undefined) {
            last++;
        }
        for (last--; last >= 0; last--) {
            own[last + count] = own[last];
            if (last < count) {
                delete own[last];
            }
        }
    }
    return Object.assign(merged, own);
}

/**
 * The scheme and authority of an absolute request target, or "" for the ordinary kind.
 *
 * A request line may carry the whole URI, and express matches on the path while leaving req.url as
 * it arrived. Same rule it uses: a "://" before any "?" means everything up to the slash after it
 * is not path.
 *
 * @param {string} url
 * @returns {string}
 */
function protohostOf(url) {
    if (url.length === 0 || url.charCodeAt(0) === 0x2f) {
        return "";
    }
    const searchIndex = url.indexOf("?");
    const pathLength = searchIndex === -1 ? url.length : searchIndex;
    const fqdnIndex = url.slice(0, pathLength).indexOf("://");
    if (fqdnIndex === -1) {
        return "";
    }
    const slash = url.indexOf("/", fqdnIndex + 3);
    return slash === -1 ? url : url.slice(0, slash);
}

/**
 * Fills in what dispatch reads on a request that did not come from µWS.
 *
 * express's router can be driven with a plain object, `router.handle({ url, method }, res, next)`,
 * and its own tests do exactly that; so does anything mounting a router on a server of its own.
 * Only ever called for such a request: one of ours arrives with these fields already set.
 *
 * req.url becomes an accessor, so the router goes on writing plain paths to it while a reader sees
 * the absolute URI it arrived as. That keeps the protohost out of the dispatch itself.
 *
 * @param {any} req
 * @param {any} router
 */
function adoptPlainRequest(req, router) {
    const arrived = typeof req.url === "string" ? req.url : "";
    const protohost = protohostOf(arrived);
    let raw = arrived.slice(protohost.length);
    if (protohost !== "") {
        Object.defineProperty(req, "url", {
            configurable: true,
            enumerable: true,
            get() {
                return protohost + raw;
            },
            set(value) {
                const written = String(value);
                raw = written.startsWith(protohost) ? written.slice(protohost.length) : written;
            }
        });
    }

    const queryIndex = raw.indexOf("?");
    const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
    req.urlQuery = queryIndex === -1 ? "" : raw.slice(queryIndex);
    req._rawQuery = req.urlQuery.slice(1);
    req.path = path;
    req.originalUrl = req.originalUrl ?? arrived;
    req._originalPath = path;
    req.endsWithSlash = path.charCodeAt(path.length - 1) === 0x2f;
    req._opPath = path;
    req._lastUrl = req.url;
    req._isOptions = req.method === "OPTIONS";
    req._isHead = req.method === "HEAD";
    req.params = req.params ?? Object.create(null);
    // null, not fresh arrays: the push sites materialize them on the first mount, and most
    // requests never see one, same as the Request constructor
    req._stack = null;
    req._consumed = 0;
    req._paramStack = null;
    req._matchedMethods = req._isOptions ? new Set() : null;
    req.routeCount = 1;
    // read when a mount is left, and there is no application here to read it from
    req.app = req.app ?? router;
}

/**
 * Refuses a handler that could never be called, where it was written rather than on the first
 * request that reaches it. Express words both of these and applications match on the text.
 *
 * @param {any[]} handlers
 * @param {string} [emptyMessage] app.use() says it its own way
 */
/**
 * The uWS onAborted handler, bound to the response: a closure here captured two locals and cost
 * a context plus a function per request, for a path that only ever runs on a client abort.
 * @this {any} the response, with the request linked as this.req
 */
function onNativeAborted() {
    const response = this;
    const request = response.req;
    // node's wording for a client abort, which is what body consumers match on
    /** @type {NodeJS.ErrnoException} */
    const err = new Error("aborted");
    err.code = "ECONNRESET";
    response.aborted = true;
    response.finished = true;
    // node's order on the request: 'aborted', then the stream dies, then 'close'. The
    // error goes only to whoever listens for it, since a destroy(err) with no listener
    // would take down the process
    request.emit("aborted");
    request.destroy(request.listenerCount("error") > 0 ? err : undefined);
    response.socket?.emit("error", err);
}

/**
 * The per-request constants of a fully literal native registration. µWS matched the URL byte for
 * byte against this exact pattern and dispatches by method, so the request constructor can take
 * these as given instead of asking uWS and recomputing them on every request.
 *
 * @param {string} path the registered pattern, which is what getUrl() would have answered
 * @param {string} method uppercase, fixed by which uWS verb the registration used
 */
function nativePreset(path, method) {
    const endsWithSlash = path.charCodeAt(path.length - 1) === 0x2f;
    return {
        path,
        method,
        endsWithSlash,
        opPath: path,
        isOptions: method === "OPTIONS",
        isHead: method === "HEAD",
        // set at registration when the whole chain provably never reads a header, or never
        // reads the query; mutable, because a middleware added after listen takes them back
        skipHeaders: false,
        skipQuery: false
    };
}

/**
 * Whether any error middleware exists anywhere under this router, mounted routers and sub-apps
 * included. The header-skip analysis needs the answer to be no: a throw inside an analyzed
 * handler would hand the request to code nobody analyzed.
 *
 * @param {any} router
 * @returns {boolean}
 */
function hasErrorMiddleware(router) {
    for (const route of router._routes) {
        for (const callback of route.callbacks) {
            // a mounted router or a callable sub-app carries routes of its own; the callable
            // app is also a function, so the routes are looked for first
            if (callback && callback._routes) {
                if (hasErrorMiddleware(callback)) {
                    return true;
                }
            } else if (typeof callback === "function" && callback.length >= 4) {
                return true;
            }
        }
    }
    return false;
}

/**
 *
 */
function checkHandlers(handlers, emptyMessage = "argument handler is required") {
    if (handlers.length === 0) {
        throw new TypeError(emptyMessage);
    }
    for (const handler of handlers) {
        if (typeof handler !== "function") {
            throw new TypeError("argument handler must be a function");
        }
    }
}

// what a route's callback is, so that a hop reads a number instead of asking instanceof and length
const CALLBACK_PLAIN = 0;
const CALLBACK_ERROR = 1;
const CALLBACK_ROUTER = 2;

/**
 * Hands the request and the response to the app about to handle them, so that a mounted sub-app's
 * settings decide what its responses do. Express re-parents both objects for the same reason.
 *
 * @param {any} req
 * @param {any} app
 */
/**
 * Reports a parameter that will not decode, unless something is already being reported.
 *
 * Matching a route decodes its parameters, and that happens while the walk is still looking for
 * whoever should answer, including when it is looking for an error handler. Express does the same
 * and keeps the first error it has: `layerError = layerError || match` in its router. Overwriting
 * meant a middleware that had already refused the path, express.static answering Bad Request on an
 * escape it could not decode, had its answer replaced by the decode failure of a route further down
 * that was never going to run. Same status, different message, and only when a later route happens
 * to match the same path. Found by fuzzing route tables against express.
 *
 * @param {any} req
 * @param {any} route
 * @param {any} err
 */
function raiseDecodeFailure(req, route, err) {
    if (req._error) {
        return;
    }
    req._error = err;
    req._errorKey = route.routeKey;
    req._errorGroup = route.group;
}

// the verbs a body is read for unless the application says otherwise, which is the parsers' own
// list. A request with any other verb reaches a parser's method check and leaves through it
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "QUERY"]);

/**
 * Whether this layer can be stepped over for this request without changing a thing.
 *
 * Only the body parsers are ever asked. Their prologue leaves a request that said nothing about a
 * body alone, whatever content type it carries, which is what `kGetSafe` already records for the
 * header-skip analysis. Two conditions on top of that mark, and both are needed:
 *
 * The request must have said nothing about framing at all, a `content-length: 0` included. A parser
 * that can see a length answers about the body it describes even when that body is empty: a zero
 * length with a charset nobody can decode is a 415, in express and here.
 *
 * And the verb must be one no parser reads a body for. With no length and no transfer-encoding a
 * POST still walks into the read, comes back with nothing, and leaves `req.body` as the empty value
 * its parser produces, which is a thing a handler can see.
 *
 * What this is worth: a hop measured 367 microseconds per thousand requests on the machine this was
 * written on, and the parser prologue it reaches measured 38. Ten to one, for a layer that had
 * nothing to do.
 *
 * That number is also why fusing consecutive layers into one generated function keeps coming up,
 * and why it is not here. Counted over a real front, morgan, helmet, compression, cors, the two body
 * parsers, express-session, a middleware of one's own and express.static: three of the nine can be
 * fused, and the longest run of fusable ones in a row is one. Fusing needs two. The rule was relaxed
 * from "calls next once, unconditionally" to merely "calls next synchronously" and the answer did
 * not move, because the six that fail all call next from inside a callback: they are asynchronous by
 * nature, reading a body, stat-ing a file, loading a session. A layer that has not decided by the
 * time it returns cannot be fused by any design that keeps the semantics. What fuses is a run of
 * trivial middlewares, which is a benchmark shape rather than an application's.
 *
 * @param {any} route
 * @param {any} req
 * @returns {boolean}
 */
function stepsOver(route, req) {
    if (route.bodyParserOnly !== true || req._hasBodyHeaders === true) {
        return false;
    }
    if (BODY_METHODS.has(req.method)) {
        return false;
    }
    // an application can add its own. Read once and kept, which is what the parser behind this
    // layer does with the same setting: asking on every request measured 17 microseconds per
    // thousand, a third of what stepping over the layer saves
    if (route.bodyMethods === undefined) {
        route.bodyMethods = req.app.get("body methods") ?? null;
    }
    return route.bodyMethods === null || !route.bodyMethods.includes(req.method);
}

/**
 * Whether a route could answer a request for this path, judged on the pattern it was compiled to.
 * A literal answers only itself; anything with a parameter or a wildcard answers what its regex
 * says. Used where the question is "would this earlier route have had its turn first".
 *
 * @param {any} route
 * @param {string} path
 * @returns {boolean}
 */
function couldAnswer(route, path) {
    if (route.pattern instanceof RegExp) {
        return route.pattern.test(path);
    }
    return route.pattern === path;
}

/**
 * Whether a layer written before a mount could answer a request for one of the paths inside it.
 *
 * A mount covers everything under its path, so this is a question about a subtree rather than about
 * the mount point, and the two answers differ: `/a` and `/:p0/:p1/:p2` match none of each other's
 * text, and both answer `/a/x/y`. µWS jumps straight to whichever leaf it registered, so a leaf a
 * layer like this could have answered has to stay on the generic path, which is the only place
 * express's registration order decides.
 *
 * Only layers with more segments than the mount path reach this: one with as few already matches
 * the mount point itself, and _optimizeRoute has refused the mount before the walk gets here.
 *
 * Compared folded whichever way the routers are set. A wrong yes costs a leaf its native
 * registration and nothing else.
 *
 * @param {{path: string, use: boolean, method: string, all: boolean}} guard
 * @param {string} leafPath the leaf's absolute path, parameters and all
 * @param {any} leaf
 * @returns {boolean}
 */
function shadowsLeaf(guard, leafPath, leaf) {
    if (!guard.all && guard.method !== leaf.method && !(guard.method === "HEAD" && leaf.method === "GET")) {
        return false;
    }
    return pathsCanOverlap(guard.path.toLowerCase(), leafPath.toLowerCase(), guard.use);
}

/**
 * The layers before a mount that answer some of what is inside it and not all of it, which is the
 * one thing neither the chain nor µWS's own choice can say: the chain runs what is in it without
 * matching again, and µWS picks by specificity. They are carried down the walk instead and asked
 * about every leaf, see shadowsLeaf.
 *
 * @param {any} router the router the mount belongs to
 * @param {any} mount
 * @param {string} pathPrefix what the mounts above this one consumed
 * @param {any[]} chain the layers that always run before the mount, which need no guard
 * @param {any[]} inherited the guards from further out, since a mount two levels down is under
 *   everything written before either of them
 * @returns {any[]|null} null when a path cannot be read segment by segment, which leaves the mount
 *   to ordinary dispatch rather than guessing about it
 */
function guardsInside(router, mount, pathPrefix, chain, inherited) {
    let guards = inherited;
    for (const r of router._routes) {
        if (r.routeKey > mount.routeKey) {
            break;
        }
        if (r === mount || chain.includes(r)) {
            continue;
        }
        if (typeof r.path !== "string") {
            return null;
        }
        if (guards === inherited) {
            guards = [...inherited];
        }
        guards.push({ path: pathPrefix + r.path, use: r.use === true, method: r.method, all: r.all === true });
    }
    return guards;
}

/**
 * Notes which application is current before a mounted one is entered, so that exact one comes back
 * when it hands over.
 *
 * Only an application takes it back. Express restores req.app by putting the request prototype
 * back, and it wraps a mounted application to do that only in Application#use: hang one off a plain
 * Router and nothing restores it, so whatever runs afterwards still reads the settings of the
 * application that was entered. Restoring regardless made a later res.send answer with the outer
 * application's etag setting where express answers with the inner.
 *
 * And what comes back is what was current, not the entered application's parent. Those differ the
 * moment a sub-app is entered from inside another sub-app that a plain Router mounted: the outer
 * one is still current, express puts that one back, and reaching for `.parent` skipped a level.
 * A 404 from the top application then carried an ETag under `app.set("etag", false)`, because the
 * settings answering were the inner application's. Found by fuzzing three levels of routers.
 *
 * The route is remembered alongside, so the pop can only ever take back what this same route put
 * there: a mounted application that answers instead of handing over leaves its entry behind, and
 * the request is over by then.
 *
 * @param {any} walk
 * @param {any} route
 * @param {any} req
 */
function rememberApp(walk, route, req) {
    if (walk.router._isApplication && route.callbacks[0]?.constructor.name === "Application") {
        (req._appStack ??= []).push(route, req.app);
    }
}

/**
 * Puts back what rememberApp noted, if this is the route that noted it.
 *
 * @param {any} route
 * @param {any} req
 */
function restoreApp(route, req) {
    const stack = req._appStack;
    if (stack !== undefined && stack.length > 0 && stack[stack.length - 2] === route) {
        const app = stack.pop();
        stack.pop();
        useApp(req, app);
    }
}

/**
 * @param {any} req
 * @param {any} app
 */
function useApp(req, app) {
    req.app = app;
    if (req.res) {
        req.res.app = app;
    }
    // an app's own request/response extensions apply while it runs: express re-parents both
    // objects on entering a mounted app, and this is the equivalent hop
    if (app.request && Object.getPrototypeOf(req) !== app.request) {
        Object.setPrototypeOf(req, app.request);
    }
    if (app.response && req.res && Object.getPrototypeOf(req.res) !== app.response) {
        Object.setPrototypeOf(req.res, app.response);
    }
}

// Every verb node knows about, which is the list the methods package hands Express, and "all" on
// top of it. Taken from node rather than written out: the written out one was missing acl, bind,
// link, rebind, source, unbind, unlink and unlock, and had four of the others twice.
//
// GET is left out on purpose. get() is declared in the class, because it doubles as the settings
// reader, and the loop at the end of this file would replace it.
const methods = ["all", ...METHODS.filter((method) => method !== "GET").map((method) => method.toLowerCase())];
const supportedUwsMethods = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "CONNECT", "TRACE"]);

// the same name rule patternToRegex reads, so a unicode name is found here too
const regExParam = /:([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)/gu;

// Internals here are _underscore and not #private: a callable router is a function with the
// router's properties copied onto it, and a # field cannot be copied, so #routes would throw
// "Cannot read private member" on the first call.

// one intermediate prototype per class, built the first time a callable of that class is made
const callablePrototypes = new WeakMap();

/**
 * The prototype for a callable router or app: the class prototype, with apply and call put back.
 *
 * Setting a function's prototype to a class prototype drops Function.prototype from the chain, and
 * node calls a request listener with handler.apply. An intermediate object, so express.application
 * stays in the chain. constructor and bind are not restored: the code asks constructor.name, and
 * BIND is an HTTP verb, so app.bind registers a route as it does in Express.
 *
 * @param {object} classPrototype
 * @returns {object}
 */
function callablePrototypeFor(classPrototype) {
    let prototype = callablePrototypes.get(classPrototype);
    if (prototype) {
        return prototype;
    }
    prototype = Object.create(classPrototype);
    for (const name of ["apply", "call", "toString"]) {
        Object.defineProperty(prototype, name, {
            value: /** @type {any} */ (Function.prototype)[name],
            writable: true,
            configurable: true,
            enumerable: false
        });
    }
    callablePrototypes.set(classPrototype, prototype);
    return prototype;
}

/**
 * The default error page, which is the one Express produces: the stack in a pre, and nothing else.
 * What reaches it has already been redacted when the environment calls for it.
 *
 * The text is escaped, which is not decoration. An error message can carry anything a client sent,
 * a path or a header among them, and writing it into the page unescaped put whatever it held into
 * the markup. The Content-Security-Policy on this response stops a script there from running, but
 * a policy is a second line and not the first. finalhandler escapes and then puts the line breaks
 * and the indentation back as markup, and this reads the same as what it produces.
 *
 * @param {any} err
 * @returns {string}
 */
function generateErrorPageHtml(err) {
    const text = String(err?.stack ?? err)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/\n/g, "<br>")
        .replace(/ {2}/g, " &nbsp;");
    return (
        `<!DOCTYPE html>\n` +
        `<html lang="en">\n` +
        `<head>\n` +
        `<meta charset="utf-8">\n` +
        `<title>Error</title>\n` +
        `</head>\n` +
        `<body>\n` +
        `<pre>${text}</pre>\n` +
        `</body>\n` +
        `</html>\n`
    );
}

module.exports = class Router extends EventEmitter {
    /**
     * The router or application this one is mounted on, undefined until it is.
     * @type {any}
     */
    parent;

    /**
     * Whether listen() has run, after which a new route can no longer reach uWS.
     * @type {boolean|undefined}
     */
    listenCalled;

    /**
     * The uWS app routes are registered on.
     *
     * Typed loosely on purpose: only an Application owns one, and the callers that reach for
     * it have already established that, so the honest `TemplatedApp|undefined` would only add
     * casts where the guard already is.
     *
     * @type {any}
     */
    uwsApp;

    /**
     * Whether an unset routing flag reads on through the mount parent. Only an application does,
     * because express chains a mounted app's settings onto its parent's; a plain Router keeps
     * whatever its options said and nothing else.
     *
     * @type {boolean}
     */
    _inheritsSettings = false;

    /**
     * Whether this is an application rather than a plain router. Read on the hop out of a mount,
     * where only an application takes req.app back, and a field rather than a name comparison
     * because that sits on the dispatch path.
     *
     * @type {boolean}
     */
    _isApplication = false;

    /**
     * Whether anything served from here has been seen reading req.ip after the response, by which
     * point µWS has freed the address. Set once, from Request#parsedIp, and read on every request
     * after that. Here rather than on Application because a plain Router serves requests of its own
     * through the node shim.
     *
     * @type {boolean}
     */
    needsIpAfterResponse = false;

    /**
     * How many requests still read the peer address up front whether or not anyone asks, so that
     * one of them can be the one that finds out. Counts to a hundred and stops: it used to be read
     * off a module-wide counter that wrapped at 100000, so the window reopened every time it did
     * and a hundred requests paid again for a discovery made long before.
     *
     * @type {number}
     */
    _ipProbes = 0;

    /**
     * The two routing flags once read, undefined until then. Express passes caseSensitive and
     * strict in when it builds a router and never looks at them again, so they are frozen here at
     * the first read rather than resolved per request.
     *
     * @type {boolean|undefined}
     */
    _strictFlag;

    /** @type {boolean|undefined} */
    _caseFlag;

    /**
     * @param {object} [settings] router options. caseSensitive and strict are accepted under the
     *   names Express's Router takes, and stored under the setting names the rest of the code reads
     */
    constructor(settings = {}) {
        super();

        this._paramCallbacks = new Map();
        this._mountpathCache = new Map();
        this._routes = [];
        // websocket routes, kept apart from the HTTP ones: µWS serves them itself and listen()
        // hands them over whole, mount paths and all
        /** @type {any[]|null} */
        this._wsRoutes = null;
        // the native presets allowed to skip the header copy, so a late middleware or an etag
        // arriving after listen can take the permission back; null until one is granted
        /** @type {Set<any>|null} */
        this._skipPresets = null;
        /** @type {boolean|undefined} */
        this._hasErrMwCache = undefined;
        // an array when mounted on several paths at once, as Express allows
        /** @type {string|string[]} */
        this.mountpath = "/";
        this.settings = settings;
        // the base classes; an Application replaces these with its own per-app subclasses, and a
        // plain router has no request/response prototype layer, as in Express
        this._request = Request;
        this._response = Response;

        if (typeof settings.caseSensitive !== "undefined") {
            this.settings["case sensitive routing"] = settings.caseSensitive;
            delete this.settings.caseSensitive;
        }
        if (typeof settings.strict !== "undefined") {
            this.settings["strict routing"] = settings.strict;
            delete this.settings.strict;
        }
    }

    /**
     * This router as middleware, which is what express.Router() hands back: a function carrying the
     * router's own properties with the router's prototype behind it. The properties are the same
     * objects, not copies, so the function and the instance are one router seen twice.
     *
     * @returns {any} the callable
     */
    _asCallable() {
        // handle() comes from the prototype set below, which nothing can see from here
        const fn = /** @type {any} */ (
            function (req, res, next) {
                return fn.handle(req, res, next);
            }
        );
        Object.assign(fn, this);
        Object.setPrototypeOf(fn, callablePrototypeFor(Object.getPrototypeOf(this)));
        return fn;
    }

    /**
     * Routes a request through this router, as Express's app.handle and router.handle do. next() is
     * called when nothing answered, so an unmatched request goes back to whoever is running this.
     *
     * @param {any} req
     * @param {any} res
     * @param {(err?: any) => void} [next]
     * @returns {Promise<void>}
     */
    async handle(req, res, next) {
        // a request from node's own server, which is what http.createServer(app) delivers
        if (isNodeRequest(req)) {
            return serveNodeRequest(this, req, /** @type {any} */ (res), next);
        }
        // an app taking over a request becomes that request's app, as it does when mounted, so
        // req.app.get("view engine") inside a sub-app reads the sub-app's settings and not the
        // settings of whatever handed the request over. A plain router is not an app and leaves it
        // alone, which is what Express's router.handle does too.
        // a plain object, which is how express's router can be driven and how its own tests drive
        // it. One of ours arrives with these set, so this costs a property read
        if (req._opPath === undefined) {
            if (typeof req.url !== "string" || req.url === "") {
                // express reads the path with parseurl, which answers nothing for these, and it
                // hands the request straight back rather than running its pathless middleware
                return next ? next() : undefined;
            }
            adoptPlainRequest(req, this);
        }
        if (this.constructor.name === "Application") {
            useApp(req, this);
        }
        // express restores req.params when a router hands back, so the caller that ran this one
        // sees the params it had before
        const callerParams = req.params;
        const routed = await this._routeRequest(req, res, 0);
        if (!routed) {
            req.params = callerParams;
            if (next) {
                // an error nobody handled belongs to the caller, as it does in express
                const err = req._error;
                if (err !== undefined) {
                    delete req._error;
                    delete req._errorKey;
                    return next(err);
                }
                next();
            }
        }
    }

    /**
     * Two methods sharing a name, as in Express.
     *
     * With a string and no handlers it reads a setting, falling back to the parent router when
     * this one does not have it. With handlers it registers a GET route. A GET route also
     * answers HEAD.
     *
     * @param {string} path setting name, or route path
     * @param {...(Function|Array<Function>)} callbacks handlers; none means read a setting
     * @returns {*} the setting value, or the created route
     */
    get(path, ...callbacks) {
        if (typeof path === "string" && callbacks.length === 0) {
            const key = path;
            const res = this.settings[key];
            if (typeof res === "undefined" && this.parent) {
                return this.parent.get(key);
            } else {
                return res;
            }
        }
        return this.createRoute("GET", path, this, ...callbacks);
    }

    /**
     * A routing flag, read once and kept. Express builds a router's matcher the first time the
     * router is needed and hands it caseSensitive and strict there, so a mount that happens after
     * that, or an app.set() that happens after that, cannot change how this router matches. Asking
     * per request instead would let a strict application make every router mounted on it strict,
     * which express does not do.
     *
     * @param {string} key the setting name
     * @returns {boolean}
     */
    _routingFlag(key) {
        const own = this.settings[key];
        if (typeof own !== "undefined") {
            return Boolean(own);
        }
        return this._inheritsSettings && this.parent ? Boolean(this.parent.get(key)) : false;
    }

    /**
     * Reads both flags at once, the first time either is wanted, because express reads both at
     * once too: it passes them together to the router it builds. Freezing them apart would let a
     * router end up strict from the moment before a mount and case sensitive from the moment
     * after it, which is a state express can never be in.
     */
    _freezeRoutingFlags() {
        if (this._strictFlag === undefined) {
            this._strictFlag = this._routingFlag("strict routing");
            this._caseFlag = this._routingFlag("case sensitive routing");
        }
    }

    /**
     * @returns {boolean} whether this router tells /things from /things/
     */
    _strictRouting() {
        this._freezeRoutingFlags();
        return /** @type {boolean} */ (this._strictFlag);
    }

    /**
     * @returns {boolean} whether this router tells /Things from /things
     */
    _caseSensitive() {
        this._freezeRoutingFlags();
        return /** @type {boolean} */ (this._caseFlag);
    }

    /**
     * The pattern matching everything the mounts on this request have consumed so far, which is
     * what a nested router strips off the path before matching against it. Cached per stack, since
     * the same mount chain is walked by every request that reaches it.
     *
     * @param {any} req
     * @returns {RegExp}
     */
    getFullMountpath(req) {
        // path-less app.use() pushes "", so a stack of only those joins to "" no matter how deep it is.
        // patternToRegex("", true) is EMPTY_REGEX, so this returns exactly what the join path would,
        // without walking the whole stack on every hop. _stackMounted first: it is 0 whenever
        // _stack is still null, and req.baseUrl asks from unmounted requests too
        if (req._stackMounted === 0 || req._stack.length === 0) {
            return EMPTY_REGEX;
        }
        const fullStack = req._stack.join("");
        let fullMountpath = this._mountpathCache.get(fullStack);
        if (!fullMountpath) {
            // a RegExp mount keys this by what it matched, which is per request, so the cache would
            // grow with the traffic. Registered paths are far fewer than this
            if (this._mountpathCache.size > 1024) {
                this._mountpathCache.clear();
            }
            // two mounts in the stack may reuse a name, which a named-group compile refuses.
            // Nothing ever reads these groups, so they are renamed by position. An escaped colon
            // is a literal one, out of a RegExp mount's matched text, and is left alone
            const stackPattern = fullStack.includes(":")
                ? fullStack.replace(/(\\?):(\w+)/g, (whole, escaped, name, at) => (escaped ? whole : ":m" + at))
                : fullStack;
            // insensitive whatever this router says, because this only finds again a prefix that
            // has already been accepted, by the routers that own those mounts and under their
            // rules. A case sensitive router mounted on an insensitive app is reached as /LIST
            // while it is registered as /list, and compiling this one its way left the prefix in
            // place and every parameter below it unread
            fullMountpath = patternToRegex(stackPattern, true, false);
            this._mountpathCache.set(fullStack, fullMountpath);
        }
        return fullMountpath;
    }

    /**
     * Whether a route's path matches this request. A plain string compares directly, which is what
     * makes a route eligible for the native router; anything carrying a parameter or a wildcard was
     * turned into a regular expression when it was registered.
     *
     * @param {any} route
     * @param {any} req
     * @returns {boolean}
     */
    _pathMatches(route, req) {
        // the path as it arrived, mount prefixes aside: whether a trailing slash is allowed is
        // written into the pattern, where express writes it too
        let path = req._opPath;
        let pattern = route.pattern;
        // the line above turns the root path into the empty string, which no pattern is written
        // against. A regex route was tested against it and app.get("*path") answered every request
        // but "/"
        if (path === "") {
            path = "/";
        }

        if (typeof pattern === "string") {
            if (pattern === "/*") {
                return true;
            }
            if (!this._caseSensitive()) {
                path = path.toLowerCase();
                pattern = pattern.toLowerCase();
            }
            if (pattern === path) {
                return true;
            }
            // a literal path is compared as text rather than compiled, so the trailing slash a
            // pattern would have carried as "/?" is allowed here instead. The registered path has
            // had its own taken off already, unless it is the root
            return (
                !this._strictRouting() &&
                path.length === pattern.length + 1 &&
                path.charCodeAt(path.length - 1) === 0x2f &&
                path.startsWith(pattern)
            );
        }
        if (pattern === EMPTY_REGEX) {
            return true;
        }
        if (route.regexMount) {
            // a mount consumes what it matched, so the match has to start the path and break on a
            // separator: express refuses /api/ as a mount of /test/api/1234 for that reason
            const matched = pattern.exec(path);
            if (!matched || path.slice(0, matched[0].length) !== matched[0]) {
                return false;
            }
            const after = path[matched[0].length];
            return after === undefined || after === "/";
        }
        return pattern.test(path);
    }

    /**
     * Registers a route, which every method helper and use() funnel into. Several paths at once
     * become several routes sharing the callbacks, as Express allows. Paths are normalised here and
     * not at match time: no trailing slash unless strict routing, "*" becomes "/{*splat}", and
     * anything not comparable as a string is compiled to a regular expression and marked complex.
     *
     * @param {string} method HTTP method, or USE for a mount
     * @param {any} path one path or several
     * @param {any} [parent] what to return, so chaining lands on the app rather than the router
     * @param {...any} callbacks
     * @returns {any} parent
     */
    createRoute(method, path, parent = this, ...callbacks) {
        method = method.toUpperCase();
        callbacks = callbacks.flat(Infinity);
        checkHandlers(callbacks);
        const paths = Array.isArray(path) ? path : [path];
        const routes = [];
        for (let path of paths) {
            // a mount always drops it, strict routing or not: strictness is about the end of a
            // path, and a mount has none. Express registers its use layers with strict off
            if (
                (method === "USE" || !this._strictRouting()) &&
                typeof path === "string" &&
                path.endsWith("/") &&
                path !== "/"
            ) {
                // every one of them, not the last: express loosens with /\/+$/, so a route written
                // "/test//" is registered as "/test" and answers "/test" and "/test/" but not the
                // path it was written as
                path = path.replace(/\/+$/, "");
            }
            if (path === "*") {
                path = "/{*splat}";
            }
            const route = {
                method: method === "USE" ? "ALL" : method,
                path,
                pattern:
                    method === "USE" || needsConversionToRegex(path)
                        ? patternToRegex(path, method === "USE", this._caseSensitive(), this._strictRouting())
                        : path,
                callbacks,
                // instanceof walks a prototype chain and length is a property load, and both used
                // to run for every callback of every hop
                callbackKinds: callbacks.map((callback) =>
                    callback instanceof Router
                        ? CALLBACK_ROUTER
                        : callback.length === 4
                          ? CALLBACK_ERROR
                          : CALLBACK_PLAIN
                ),
                // A body parser, and nothing else: they carry the mark that says their prologue
                // leaves a request that declared no body alone. Reaching one costs a hop, and the
                // hop measures ten times what the prologue does, so a request that provably gets
                // nothing out of it steps over the whole layer. See stepsOver
                bodyParserOnly: method === "USE" && callbacks.length === 1 && callbacks[0][kGetSafe] === true,
                // the "body methods" setting as it stood the first time this layer was reached,
                // kept the way the parser behind it keeps it. undefined until then
                bodyMethods: undefined,
                // a mount written as a RegExp matches a piece of path that is not known until a
                // request comes in, so its stack entry cannot be the path itself
                regexMount: method === "USE" && path instanceof RegExp,
                // written by the application, so express matches it as it stands
                userRegexp: path instanceof RegExp,
                routeKey: routeKey++,
                // which app.route() this came from, when it came from one, so the routes it built
                // count as one route where an error is concerned. undefined for every other route
                group: this._pendingGroup,
                // the router this was registered on. Ordinary dispatch is done by that router, so
                // it could ask itself, but an optimized chain is walked by the app whatever it
                // contains, and param() callbacks belong to the router that declared them
                owner: this,
                // and its callbacks by reference, since dispatch asks for them on every hop of
                // every request and param() only ever writes into this map, never replaces it.
                // Reading them through owner measured 8 microseconds per thousand requests
                paramCallbacks: this._paramCallbacks,
                use: method === "USE",
                all: method === "ALL" || method === "USE",
                gettable: method === "GET" || method === "HEAD"
            };
            if (
                route.pattern instanceof RegExp &&
                // a RegExp the application wrote: its capture groups are params too
                (path instanceof RegExp ||
                    (typeof route.path === "string" &&
                        (route.path.includes(":") || route.path.includes("*") || route.path.includes("{"))))
            ) {
                route.complex = true;
            }
            routes.push(route);
        }
        this._routes.push(...routes);

        // anything registered after listen invalidates what the header-skip analysis proved:
        // it could catch a throw or read what a chain never did, so every skip is taken back
        this._hasErrMwCache = undefined;
        if (this._skipPresets?.size) {
            for (const preset of this._skipPresets) {
                preset.skipHeaders = false;
                preset.skipQuery = false;
            }
            this._skipPresets.clear();
        }

        return parent;
    }

    /**
     * The chain a request would walk to reach this route, or false when it cannot be known ahead of
     * time. The native router jumps straight to the route, so everything registered before it that
     * could also match has to be in the chain, in order.
     *
     * @param {any} route
     * @param {any[]} routes every route of this router, in registration order
     * @returns {any[]|false} the chain, ending in the route itself
     */
    _optimizeRoute(route, routes) {
        const optimizedPath = [];
        // a route with a parameter matches paths its own text does not, so what an earlier route
        // could answer is compared shape against shape and not against that text
        const withParams = typeof route.path === "string" && route.path.includes(":");
        // under insensitive routing two paths that differ only in case answer the same requests,
        // so the text comparisons below run on the folded form. µWS itself still matches bytes:
        // a request in the registered case takes the chain, any other case takes the fallback,
        // and both answer as express would as long as the chain agrees with registration order
        const caseSensitive = this._caseSensitive();
        const routePathFolded = caseSensitive || typeof route.path !== "string" ? route.path : route.path.toLowerCase();
        // whether this route answers only the path as written, or the one with a trailing slash too
        const strictHere = (route.owner ?? this)._strictRouting();
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
                    // A mount is registered ALL, because what lives under it can answer any
                    // method, and this chain is computed once for all of them. So an earlier
                    // route of some other method is not irrelevant here the way it is for a
                    // plain route: it belongs in the chain of the leaves that share its method
                    // and in no other, and one chain cannot say that. µWS would then jump
                    // straight to a leaf and answer as though the earlier route did not exist,
                    // which is what let a literal route inside a mounted router beat a parameter
                    // route written before the mount. Leave the mount to ordinary dispatch,
                    // where express's own order is what decides.
                    if (route.use && typeof route.path === "string" && couldAnswer(r, route.path)) {
                        return false;
                    }
                    continue;
                }
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
            // Both spellings of this route's path are tried, because without strict routing it
            // answers "/x/" as well as "/x", and an earlier pattern that matches only the first is
            // still an earlier pattern that answers a request this registration would take.
            if (
                (r.pattern instanceof RegExp &&
                    (!withParams || r.use) &&
                    (r.pattern.test(route.path) || (!strictHere && r.pattern.test(route.path + "/")))) ||
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
            // registration of "/posts", so µWS hands it here instead, where this chain would
            // answer as if the earlier route did not exist. The literal is remembered so the
            // registration can send those requests to the generic router, which is the only place
            // express's own order can decide; a path with no letter in it has no other case to
            // arrive in and needs no guard
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
     */
    _compileOptimizedRoutes() {
        if (!this.uwsApp) {
            return;
        }

        // pathPrefix/chainPrefix accumulate across nested sole-callback mounts, and outerGuards
        // carries what was written before them and answers only part of what is under them
        const walk = (router, pathPrefix, chainPrefix, outerGuards) => {
            for (const route of router._routes) {
                if (route.use) {
                    // only sole-callback mounts. Case rules do not gate the walk: each level's
                    // _optimizeRoute guards its own routes under its own setting, and a request
                    // in any other case than the registered one takes the fallback, which
                    // honours the child's setting on its own
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
                    (canBeOptimized(route.path) ||
                        // parameters that are whole segments are matched by µWS the same way
                        (canBeOptimizedWithParams(route.path) &&
                            // inside a mounted router, only when nothing after it could match
                            (!pathPrefix || !router._isFollowedByAnOverlap(route, router._routes)))) &&
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
                        this._registerUwsRoute(registered, chain);
                        // the chain holds the original object, so the request-time guard has to
                        // find the computed fields there, or a mounted param route extracts its
                        // params twice. The names match: the prefix is static, so the copy's path
                        // adds no parameter of its own
                        route.optimizedParams = registered.optimizedParams;
                        route.optimizedPath = registered.optimizedPath;
                        // and what was decided about it, for the same reason: the copy is thrown
                        // away and the profile reads the route the application actually holds
                        route._native = registered._native;
                    } else {
                        this._registerUwsRoute(route, chain);
                    }
                } else if (!supportedUwsMethods.has(route.method)) {
                    route._whyGeneric = `µWS does not serve ${route.method}`;
                } else if (canBeOptimizedWithParams(route.path)) {
                    // eligible but for the overlap test, which only applies inside a mount
                    route._whyGeneric = "a route after it in the same mounted router could answer the same paths";
                } else {
                    route._whyGeneric = "µWS cannot match this path on its own";
                }
            }
        };

        walk(this, "", [], []);
    }

    /**
     * Wraps a uWS request and response in ours and links them, which is the first thing every
     * request does whichever path serves it. The response rides back as request.res: returning
     * a `{ request, response }` pair was one throwaway object per request.
     *
     * @param {any} res uWS response
     * @param {any} req uWS request, readable only during this call
     * @param {any} [preset] a literal registration's constants, see nativePreset
     * @param {any} [skipHolder] the object a granted header skip lives on: the preset itself
     *   for a literal registration, a holder of its own for a parameterised one
     * @returns {any} the request, with the response reachable as request.res
     */
    handleRequest(res, req, preset, skipHolder) {
        const request = new this._request(req, res, this, preset, skipHolder);
        const response = new this._response(res, request, this);
        request.res = response;

        return request;
    }

    /**
     * Tells uWS whom to call on a client abort. Out of handleRequest, because uWS only needs it
     * for a response that outlives its handler callback: the native handler arms it in its
     * finally when the answer is still pending, which on a synchronous route it never is.
     *
     * @param {any} res uWS response
     * @param {any} response
     */
    _armAbort(res, response) {
        res.onAborted(onNativeAborted.bind(response));
    }

    /**
     * Whether a route registered later in the same router could match a path this one matches.
     *
     * A route inside a mounted router may only go to µWS when the answer is no: a native chain that
     * runs out resumes after the mount, not inside the router, so a later sibling would be lost. A
     * mount or a pattern of an unknown shape counts as an overlap; two paths µWS could match itself
     * are compared segment by segment.
     *
     * @param {any} route
     * @param {any[]} routes every route of the router this one belongs to
     * @returns {boolean}
     */
    _isFollowedByAnOverlap(route, routes) {
        // folded under insensitive routing, where a case variant answers the same requests
        const caseSensitive = this._caseSensitive();
        const routePath = caseSensitive ? route.path : route.path.toLowerCase();
        for (let i = routes.length - 1; i >= 0; i--) {
            const later = routes[i];
            if (later.routeKey <= route.routeKey) {
                return false;
            }
            // a different verb cannot answer the same request, unless it answers every verb
            if (!later.all && !later.use && later.method !== route.method) {
                continue;
            }
            if (later.use) {
                return true;
            }
            if (typeof later.path === "string" && canBeOptimizedWithParams(later.path)) {
                if (pathsCanOverlap(routePath, caseSensitive ? later.path : later.path.toLowerCase())) {
                    return true;
                }
                continue;
            }
            return true;
        }
        return false;
    }

    /**
     * Hands one route to µWS, along with the chain of everything that has to run in front of it,
     * and records that chain on the route so the handler can walk it.
     *
     * @param {any} route
     * @param {any[]} optimizedPath the routes to run, in order, ending with this one
     */
    _registerUwsRoute(route, optimizedPath) {
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
            ? route._caseGuards.map((p) =>
                  needsConversionToRegex(p) ? patternToRegex(p, false, false) : p.toLowerCase()
              )
            : null;
        const makeHandler = (chain, preset, skips) => {
            // the mutable object a granted skip lives on, so a middleware arriving after
            // listen can take it back: a literal registration's preset doubles as it, and a
            // parameterised one, which has no preset, gets a holder of its own
            let skipHolder = preset;
            if (skipHolder === undefined && (skips.skipHeaders || skips.skipQuery)) {
                skipHolder = { skipHeaders: skips.skipHeaders, skipQuery: skips.skipQuery };
                (this._skipPresets ??= new Set()).add(skipHolder);
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
                    return /** @type {any} */ (this)._serveGeneric(res, req);
                }
                const request = this.handleRequest(res, req, preset, skipHolder);
                const response = request.res;
                if (optimizedParams) {
                    request.optimizedParams = new NullObject();
                    for (let i = 0; i < optimizedParams.length; i++) {
                        request.optimizedParams[optimizedParams[i]] = req.getParameter(i);
                    }
                }
                const walk = new Walk(this, request, response, chain, true, skipUntil, nativeDone, nativeFail);
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
                        this._armAbort(res, response);
                    }
                }
            };
        };
        // a HEAD route may sit in a GET route's chain so the head registration runs it, but a
        // chain runs without re-matching the method, so the get registration must not see it
        const getChain =
            route.method === "GET" ? optimizedPath.filter((r) => r.all || r.method !== "HEAD") : optimizedPath;
        route.optimizedPath = optimizedPath;
        const headChain = getChain.length === optimizedPath.length ? getChain : optimizedPath;

        // A fully literal registration knows path and method here, so each registration site
        // hands the request constructor its own constants. An "any" registration serves every
        // verb and a parameterised one matches paths it cannot spell, so both stay dynamic
        const canPreset = !route.optimizedParams && method !== "any";
        // the route's own router decides, not the app running the registration: a router created
        // with { strict: true } and mounted on an app without it does not answer /things/, and
        // registering that path here is the only way it could
        const strictHere = (route.owner ?? this)._strictRouting();

        // Whether requests served by this registration may skip the header copy: GET and its
        // HEAD twins only, the app must not compute etags (send would consult freshness
        // headers), no error middleware may exist anywhere (a throw hands the request to code
        // the analysis never saw), and every callback in the chain has to pass the source
        // analysis in usage.js, whose default answer is no.
        const NO_SKIPS = { skipHeaders: false, skipQuery: false };
        let getSkips = NO_SKIPS;
        let headSkips = NO_SKIPS;
        if (route.method === "GET" && this.get("etag") === false) {
            let hasErr = this._hasErrMwCache;
            if (hasErr === undefined) {
                hasErr = this._hasErrMwCache = hasErrorMiddleware(this);
            }
            if (!hasErr) {
                // a terminal next() may only fall into the framework's own 404, so no later
                // route may be able to catch the same path
                const owner = route.owner ?? this;
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
                (this._skipPresets ??= new Set()).add(preset);
            }
            return preset;
        };

        let fn = makeHandler(
            getChain,
            canPreset ? makePreset(route.path, route.method, getSkips) : undefined,
            getSkips
        );
        const jsFn = fn;

        let replacedPath = route.path;

        // the response prototype the route will really run under: its own app's, which sees a
        // method patched there or inherited from a parent app, falling back to the registering app
        const responseProto = /** @type {any} */ (route.owner)?.response ?? /** @type {any} */ (this).response;
        // check if route is declarative
        if (
            optimizedPath.length === 1 && // must not have middlewares
            route.callbacks.length === 1 && // must not have multiple callbacks
            typeof route.callbacks[0] === "function" && // must be a function
            route.paramCallbacks.size === 0 && // a param callback has to run, and this answers without running anything
            // a declarative response is answered by µWS itself, so no javascript runs and the case
            // guard could not: a route that needs one has to stay an ordinary handler
            caseGuards === null &&
            !resDecMethods.some((method) => resCodes[method] !== responseProto[method].toString()) && // must not have injected methods
            this.get("declarative responses") // must have declarative responses enabled
        ) {
            const decRes = compileDeclarative(route.callbacks[0], this);
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

        this.uwsApp[method](replacedPath, fn);
        if (!strictHere && route.path[route.path.length - 1] !== "/") {
            // a declarative response answers the twin as itself; a preset handler cannot be
            // shared, since the twin's path is its own constant
            const slashFn =
                fn !== jsFn
                    ? fn
                    : canPreset
                      ? makeHandler(getChain, makePreset(route.path + "/", route.method, getSkips), getSkips)
                      : fn;
            this.uwsApp[method](replacedPath + "/", slashFn);
            if (method === "get") {
                this.uwsApp.head(
                    replacedPath + "/",
                    makeHandler(
                        headChain,
                        canPreset ? makePreset(route.path + "/", "HEAD", headSkips) : undefined,
                        headSkips
                    )
                );
            }
        }
        if (method === "get") {
            // its own handler always: the shared one would carry the GET registration's method
            this.uwsApp.head(
                replacedPath,
                makeHandler(headChain, canPreset ? makePreset(route.path, "HEAD", headSkips) : undefined, headSkips)
            );
        }
    }

    /**
     * Gives an error to the handler that asked for it, or answers with it when there is none.
     * Passing something to next() from an error handler clears the error and resumes routing,
     * which is how Express lets a handler decide the error was not fatal.
     *
     * @param {any} err
     * @param {Function|null} handler the four-argument handler to call, or null for the default
     * @param {any} request
     * @param {any} response
     */
    _handleError(err, handler, request, response) {
        if (handler) {
            const next = (pass) => {
                delete request._error;
                delete request._errorKey;
                return request.next(pass);
            };
            try {
                return handler(err, request, response, next);
            } catch (thrown) {
                // what an error handler throws is the error the next one gets
                request._error = thrown;
                return request.next(thrown);
            }
        }
        console.error(err);
        if (response.statusCode === 200) {
            // the status the error carries, as express's own final handler reads it: a body that
            // was too large or a request cut short is the client's 4xx, not a 500 from here
            const status = err?.status ?? err?.statusCode;
            response.statusCode = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
        }
        this._sendErrorPage(request, response, err, true);
    }

    /**
     * The HTML for an error, which in production says only what the status means rather than what
     * went wrong, so a stack trace does not reach the client.
     *
     * @param {any} err
     * @param {number} statusCode
     * @param {boolean} [checkEnv] whether production should redact it
     * @returns {string}
     */
    _generateErrorPage(err, statusCode, checkEnv = false) {
        if (checkEnv && this.get("env") === "production") {
            err =
                statusCode >= 400 ? (statuses.message[statusCode] ?? "Internal Server Error") : "Internal Server Error";
        }
        return generateErrorPageHtml(err);
    }

    /**
     * @param {import("./utils.js").PathRegExp} pattern
     * @param {string} path
     */
    _extractParams(pattern, path) {
        let match = pattern.exec(path);
        if (!match && path.length > 1 && path.endsWith("/")) {
            // a pattern compiled without a trailing slash still matches a path written with one,
            // which is what non-strict routing means. Retried rather than stripped up front, so
            // that a wildcard captures the path as it arrived and "/a/b/" keeps its last, empty
            // segment the way Express reports it
            match = pattern.exec(path.slice(0, -1));
        }
        // Object.create(null) rather than the { __proto__: null } literal, which is the same object
        // for 9ns more. Null-prototyped either way, as Express 5 makes params.
        const obj = Object.create(null);
        if (!match) {
            return obj;
        }

        const meta = getPatternMeta(pattern);
        if (meta === undefined) {
            // a RegExp the application supplied itself, which was never compiled here: every
            // capture group lands in params, named ones under their name and the rest under their
            // position, which is what express does with one
            const keys = regexpGroupKeys(pattern);
            for (let i = 1; i < match.length; i++) {
                const value = match[i];
                if (value === undefined) {
                    continue;
                }
                obj[keys[i - 1]] = decodeParam(value);
            }
            return obj;
        }
        if (!match.groups) {
            return obj;
        }

        const groups = match.groups;

        // asking for each name in turn rather than walking the groups object, which is a
        // null-prototype dictionary and slow to enumerate, and reading the wildcard answer that was
        // worked out when the pattern was compiled instead of searching an array for it
        const { paramNames, outputNames, isWildcard } = meta;
        for (let i = 0, len = paramNames.length; i < len; i++) {
            const name = outputNames[i];
            const value = groups[paramNames[i]];
            // an optional group that did not match is absent in v5, not present as undefined
            if (value === undefined) {
                continue;
            }
            // a wildcard is an array of segments in v5, and each segment is decoded on its own so
            // that an encoded slash inside one stays inside it
            obj[name] = isWildcard[i] ? value.split("/").map(decodeParam) : decodeParam(value);
        }
        return obj;
    }

    /**
     * Fills in what a route needs before its handlers run: req.route, req.params from the pattern
     * and from any mergeParams parents, and the app.param callbacks for the parameters this route
     * matched that this request has not already seen.
     *
     * @param {any} req
     * @param {any} res
     * @param {any} route
     * @returns {any} a promise only when a param callback is involved
     */
    _preprocessRequest(req, res, route) {
        req.route = route;
        // both, not the route flag alone: the flag says the route was registered natively, the
        // values say this request came in that way
        if (route.optimizedParams && req.optimizedParams) {
            req.params = Object.create(null);
            try {
                // µWS hands back the raw text, as the regex does, so both paths decode here
                for (const name in req.optimizedParams) {
                    req.params[name] = decodeParam(req.optimizedParams[name]);
                }
            } catch (err) {
                raiseDecodeFailure(req, route, err);
                return "route";
            }
        } else if (route.complex) {
            // the path with the mounts taken off, which is what _opPath is
            const path = req._opPath;
            try {
                req.params = this._extractParams(route.pattern, path);
            } catch (err) {
                // a parameter that will not decode. Express throws out of the match and lets the
                // error reach the error handler, which answers 400, so the route is skipped rather
                // than run with a value nobody can read.
                raiseDecodeFailure(req, route, err);
                return "route";
            }
            if (mergesParams(route, this) && req._paramStack !== null && req._paramStack.length > 0) {
                req.params = mergeParams(req.params, req._paramStack);
            }
        } else {
            // express 5 gives every matched route null-prototype params; only a pathless
            // middleware layer keeps the plain object, as its router hands one to fast_slash
            req.params = route.use && route.path === "" ? {} : Object.create(null);
            if (mergesParams(route, this) && req._paramStack !== null && req._paramStack.length > 0) {
                req.params = mergeParams(req.params, req._paramStack);
            }
        }

        // the route's own router's callbacks: an optimized chain is walked by the app even when it
        // ends in a mounted router's route
        const paramCallbacks = route.paramCallbacks;
        if (paramCallbacks.size > 0) {
            return this._runParamCallbacks(req, res, route, paramCallbacks);
        }
        return true;
    }

    /**
     * Whether this route's parameters carry a percent escape that will not decode. Asked only of a
     * route whose path matched and whose method did not, which express still decodes: the 400 it
     * answers there is what this reproduces.
     *
     * @param {any} route
     * @param {any} req
     * @returns {boolean}
     */
    _paramsFailToDecode(route, req) {
        if (!route.complex) {
            return false;
        }
        try {
            this._extractParams(route.pattern, req._opPath);
            return false;
        } catch {
            return true;
        }
    }

    /**
     * Runs the app.param() callbacks for the parameters this route matched, and says whether the
     * route may run.
     *
     * Express calls one once per value and not once per request: the same name matched with a
     * different value calls it again, and a value it has already seen restores whatever that call
     * left in req.params, its deferral or its error included, without running anything.
     *
     * @param {any} req
     * @param {any} res
     * @param {any} route
     * @param {Map<string, Function[]>} paramCallbacks the owning router's, which is also the key of
     *   its own cache: two routers that declare the same parameter each call their own
     * @returns {Promise<true|"route">|true}
     */
    _runParamCallbacks(req, res, route, paramCallbacks) {
        let names;
        for (const name in req.params) {
            if (paramCallbacks.has(name)) {
                (names ??= []).push(name);
            }
        }
        if (!names) {
            return true;
        }
        const perRouter = (req._paramCalled ??= new Map());
        let called = perRouter.get(paramCallbacks);
        if (!called) {
            perRouter.set(paramCallbacks, (called = new Map()));
        }

        return new Promise((resolve) => {
            let index = 0;
            let name = "";
            let value;
            let entry;
            let fns = [];
            let fnIndex = 0;

            // one parameter after the other, err being what the last one's callbacks ended with
            const nextParam = (err) => {
                if (err) {
                    if (err !== "route") {
                        req._error = err;
                        req._errorKey = route.routeKey;
                        req._errorGroup = route.group;
                    }
                    // the route is skipped either way: an error carries on to the error handlers
                    return resolve("route");
                }
                if (index >= names.length) {
                    return resolve(true);
                }
                name = names[index++];
                value = req.params[name];
                entry = called.get(name);
                if (entry && (entry.match === value || (entry.error && entry.error !== "route"))) {
                    req.params[name] = entry.value;
                    return nextParam(entry.error);
                }
                entry = { error: null, match: value, value };
                called.set(name, entry);
                fns = /** @type {Function[]} */ (paramCallbacks.get(name));
                fnIndex = 0;
                nextCallback(undefined);
            };

            // and one callback of the current parameter after the other
            const nextCallback = (err) => {
                const fn = fns[fnIndex++];
                // read before the callback runs and again after it: one that rewrites
                // req.params[name] hands that value to every later route
                entry.value = req.params[name];
                if (err) {
                    entry.error = err;
                    return nextParam(err);
                }
                if (!fn) {
                    return nextParam(undefined);
                }
                req.next = nextCallback;
                try {
                    fn(req, res, nextCallback, value, name);
                } catch (thrown) {
                    nextCallback(thrown);
                }
            };

            nextParam(undefined);
        });
    }

    /**
     * Registers a callback that runs whenever a route parameter of this name is matched, before
     * the route's own handlers, once per request per parameter.
     *
     * @example
     * app.param("id", (req, res, next, value) => { req.user = lookup(value); next(); });
     *
     * @param {string|string[]} name parameter name, or several
     * @param {(req: object, res: object, next: Function, value: string, name: string) => void} fn
     * @returns {this} the router, for chaining
     * @throws {TypeError} if name is neither a string nor an array
     */
    param(name, fn) {
        // the message has to read exactly like this: it is the one the router package throws,
        // and it is what reaches anyone catching it
        if (typeof name !== "string" && !Array.isArray(name)) {
            throw new TypeError("argument name must be a string");
        }
        if (fn === undefined) {
            throw new TypeError("argument fn is required");
        }
        if (typeof fn !== "function") {
            throw new TypeError("argument fn must be a function");
        }
        const names = Array.isArray(name) ? name : [name];
        for (const key of names) {
            if (!this._paramCallbacks.has(key)) {
                this._paramCallbacks.set(key, []);
            }
            this._paramCallbacks.get(key).push(fn);
        }
        return this;
    }

    /**
     * Resolves with the route that answered, or false when nothing matched.
     * @returns {Promise<any>}
     */
    _routeRequest(req, res, startIndex = 0, routes = this._routes, skipCheck = false, skipUntil) {
        return new Promise((resolve, reject) => {
            new Walk(this, req, res, routes, skipCheck, skipUntil, resolve, reject).dispatch(startIndex);
        });
    }

    /**
     * Mounts middleware, or a whole router, at a path. The path is optional, and a mount matches
     * everything under it, which is what separates it from all(). Mounting a Router sets its
     * mountpath and parent and emits 'mount' on it.
     *
     * @param {string|RegExp|string[]|Function|Router|Array<Function|Router>} [path] mount path, or
     *   the first handler
     * @param {...(Function|Router|Array<Function|Router>)} callbacks handlers, nested arrays allowed
     * @returns {this} the router, for chaining
     */
    use(path, ...callbacks) {
        if (
            typeof path === "function" ||
            path instanceof Router ||
            (Array.isArray(path) && path.flat(Infinity).every((p) => typeof p === "function" || p instanceof Router))
        ) {
            callbacks.unshift(/** @type {Function|Router|Array<Function|Router>} */ (path));
            path = "";
        }
        if (path === "/") {
            path = "";
        }
        callbacks = callbacks.flat(Infinity);
        checkHandlers(
            callbacks,
            this.constructor.name === "Application" ? "app.use() requires a middleware function" : undefined
        );

        for (const callback of callbacks) {
            if (callback instanceof Router) {
                // the recorded mountpath is what express shows: a pathless or root mount says "/",
                // while the empty string stays internal to route building
                callback.mountpath = /** @type {string|string[]} */ (path === "" ? "/" : path);
                callback.parent = this;
                callback.emit("mount", this);
            }
        }
        this.createRoute("USE", path, this, ...callbacks);
        return this;
    }

    /**
     * Registers a websocket route, which µWS serves itself.
     *
     * The behavior is µWS's, settings and socket handlers alike, plus one addition: an
     * `upgrade(req, res)` of this project's own shape, which runs before the handshake with a
     * real request and response. Answering with the response declines the socket, which is how
     * a check refuses one; returning a promise holds the handshake until it settles.
     *
     * The request lives as long as the socket and reaches every handler as `ws.req`, so what
     * the upgrade learned about the client, and anything it hangs on the request, is there when
     * a message arrives.
     *
     * @example
     * app.ws("/room/:id", {
     *     upgrade(req, res) {
     *         if (!req.query.token) return res.sendStatus(401);
     *         req.room = req.params.id;
     *     },
     *     open(ws) { ws.subscribe(ws.req.room); },
     *     message(ws, message, isBinary) { ws.publish(ws.req.room, message, isBinary); }
     * });
     *
     * @param {string} path a literal path, or one whose parameters are whole segments
     * @param {object} behavior µWS's WebSocketBehavior, plus the optional `upgrade` above
     * @returns {this}
     */
    ws(path, behavior) {
        checkBehavior(path, behavior);
        (this._wsRoutes ??= []).push({ path, behavior, owner: this });
        return this;
    }

    /**
     * A builder for one path, so the path is written once and the verbs chain off it.
     *
     * @example
     * app.route("/book").get(list).post(create);
     *
     * @param {string} path the path every verb on the returned object registers against
     * @returns {object} an object with one method per HTTP verb, each returning it again
     */
    route(path) {
        // everything hung off one app.route() shares this, which is what makes them one route as
        // far as an error is concerned, see errorHop
        const group = ++routeGroups;
        const fns = new NullObject();
        const inGroup = (method, callbacks) => {
            this._pendingGroup = group;
            try {
                return this.createRoute(method, path, /** @type {any} */ (fns), ...callbacks);
            } finally {
                this._pendingGroup = undefined;
            }
        };
        for (const method of methods) {
            fns[method] = (...callbacks) => inGroup(method, callbacks);
        }
        fns.get = (...callbacks) => inGroup("GET", callbacks);
        return fns;
    }

    /**
     * Answers with an error page, locked down: no sniffing, no ETag, and a content security policy
     * that allows nothing, since the page carries a message that came from somewhere else.
     *
     * @param {any} request
     * @param {any} response
     * @param {any} err
     * @param {boolean} [checkEnv] whether production should redact it
     */
    _sendErrorPage(request, response, err, checkEnv = false) {
        err = this._generateErrorPage(err, response.statusCode, checkEnv);
        request.noEtag = true;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy", "default-src 'none'");
        response.send(err);
    }

    /**
     * The automatic OPTIONS reply, built from the methods the walk collected. Throws instead of
     * answering when the head has already been written, which is what node's setHeader would do
     * and what lets an error handler see it, as in Express.
     *
     * @param {any} request
     * @param {any} response
     * @param {Set<string>} methods the verbs the answering router knows, which are its own
     */
    _sendOptionsReply(request, response, methods) {
        if (response._headWritten) {
            throw new Error("Cannot set headers after they are sent to the client");
        }
        // Express 5 sorts the methods and joins them with ", ", so the header reads the same
        // regardless of the order the routes happened to be registered in
        const allowedMethods = Array.from(methods).sort().join(", ");
        response.setHeader("Allow", allowedMethods);
        // the router package answers this one itself, with a plain-text body, the nosniff
        // header and end() rather than send(), so no ETag comes with it
        response.setHeader("Content-Type", "text/plain");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.end(allowedMethods);
    }

    /**
     * How a request that nothing answered ends: with the error it carries, with the automatic
     * OPTIONS reply, or with a 404. The native chain, the app's catch-all handler and the node shim
     * all end here, so that they end a request the same way.
     *
     * @param {any} request
     * @param {any} response
     */
    _endUnmatched(request, response) {
        if (request._error) {
            return this._handleError(request._error, null, request, response);
        }
        if (request._isOptions && request._matchedMethods.size > 0) {
            try {
                this._sendOptionsReply(request, response, request._matchedMethods);
            } catch (err) {
                // a head already written: the error answers instead, as express's does
                this._handleError(err, null, request, response);
            }
            return;
        }
        response.status(404);
        // the whole path, not what a mount left behind in req.path
        this._sendErrorPage(request, response, `Cannot ${request.method} ${request._originalPath}`, false);
    }
};

// The verb methods go on the prototype, not on each instance. As own arrows they closed over the
// instance they were built on, so express.Router().post(...) answered with the object the callable
// was copied from. One closure per name for the process instead of one per router, too.
for (const method of methods) {
    module.exports.prototype[method] = function (path, ...callbacks) {
        return this.createRoute(method, path, this, ...callbacks);
    };
}
