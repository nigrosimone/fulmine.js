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
    mountPrefixLength,
    setMountedPath,
    stepsOver,
    rememberApp,
    restoreApp,
    useApp,
    CALLBACK_ERROR,
    CALLBACK_ROUTER
} = require("./router-utils.js");

/** @typedef {import("./request.js")} Request */
/** @typedef {import("./response.js")} Response */
/** @typedef {import("./router.js")} Router */
/** @typedef {import("./router-utils.js").RouteEntry} RouteEntry */

/**
 * One walk of one router's routes for one request: next() is made once, not per hop (a closure
 * per hop captured eleven bindings). A nested router gets its own walk.
 */
class Walk {
    /** @type {Router} */
    router;

    /** @type {Request} */
    req;

    /** @type {Response} */
    res;

    /** The route table, or a compiled chain. @type {RouteEntry[]} */
    routes;

    /** Take the route at the index without matching it, a compiled chain. @type {boolean} */
    skipCheck;

    /** The route to resume after when a compiled chain runs out. @type {RouteEntry|undefined} */
    skipUntil;

    /** @type {(value: RouteEntry|false) => void} */
    resolve;

    /** @type {(err: unknown) => void} */
    reject;

    /** Whether the walk answered, read by the native pair only. @type {boolean} */
    settled = false;

    /** @type {number} */
    routeIndex = 0;

    /** The route being run. @type {RouteEntry|null} */
    route = null;

    /** @type {number} */
    callbackIndex = 0;

    /** step() bound once: an arrow forwarding into it measured 495us per thousand requests. @type {(thingamabob?: unknown) => void} */
    next;

    /**
     * What res.sendFile reports a failure to, the router next as express's req.next; bound on the
     * first route with more than one callback.
     * @type {((err?: unknown) => void)|null}
     */
    leaveRoute = null;

    /**
     * @param {Router} router
     * @param {Request} req
     * @param {Response} res
     * @param {RouteEntry[]} routes the route table, or a compiled chain
     * @param {boolean} skipCheck take the route at the index without matching it, a compiled chain
     * @param {RouteEntry|undefined} skipUntil the route to resume after when this chain runs out
     * @param {(value: RouteEntry|false) => void} resolve
     * @param {(err: unknown) => void} reject
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
        this.next = this.step.bind(this);
    }

    /**
     * Leaves the rest of this route, with the error if there is one.
     *
     * @param {unknown} [err] whatever was thrown, which need not be an Error
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
     * Finds the next matching route and runs it; next() comes back here for the one after.
     *
     * @param {number} startIndex where to resume the scan
     * @returns {void}
     */
    dispatch(startIndex) {
        const req = this.req;
        const routes = this.routes;
        const router = this.router;
        // a middleware assigned req.url or req.method (method-override), which express honours;
        // out of line so this stays small enough to inline
        if (req.url !== req._lastUrl && this.takeUrlRewrite(startIndex)) {
            return;
        }
        if (req.method !== req._lastMethod && this.takeMethodRewrite(startIndex)) {
            return;
        }
        let routeIndex = startIndex;
        // a compiled chain steps over the layers that provably have nothing to do
        if (this.skipCheck) {
            while (routeIndex < routes.length && routes[routeIndex].bodyParserOnly === true) {
                if (!stepsOver(routes[routeIndex], req)) {
                    break;
                }
                routeIndex++;
            }
        }
        if (!this.skipCheck) {
            // express decodes a matched layer's parameters before the method check, so a bad
            // escape is a 400 even with no route of this method; only a path with a percent can
            const mayFailDecode = (req._mayFailDecode ??= req._originalPath.indexOf("%") !== -1);
            // once per scan, per route it measured 0.45us over four hundred routes
            router._freezeRoutingFlags();
            if (routes === router._routes) {
                // through the literal index, see _scanFrom
                routeIndex = router._scanFrom(req, routeIndex, mayFailDecode);
            } else {
                // a short chain array, scanned linearly, written out (a predicate was a closure per hop)
                const method = req.method;
                const length = routes.length;
                for (; routeIndex < length; routeIndex++) {
                    const r = routes[routeIndex];
                    // a HEAD enters a matched route whose verb cannot serve it, as express exempts
                    // HEAD from the method check, so its param() callbacks run; runRoute steps over it
                    if (!(
                        r.all ||
                        r.method === method ||
                        req._isOptions ||
                        (req._isHead && (r.gettable || r.paramCallbacks.size > 0))
                    )) {
                        // taken only to fail: _preprocessRequest decodes and raises the error
                        if (mayFailDecode && router._pathMatches(r, req) && router._paramsFailToDecode(r, req)) {
                            break;
                        }
                        continue;
                    }
                    if (router._pathMatches(r, req)) {
                        if (r.bodyParserOnly === true && stepsOver(r, req)) {
                            continue;
                        }
                        break;
                    }
                }
            }
        }
        const route = routes[routeIndex];
        if (!route) {
            if (!this.skipCheck) {
                return this.resolve(false);
            }
            // the chain ran out: ordinary routing takes over from the top, skipping what ran
            useApp(req, router);
            // a chain that went into a mount never left it (keepMount), so the path is still relative
            if (req._stack !== null && req._stack.length > 0) {
                req._stack.length = 0;
                req._consumed = 0;
                setMountedPath(req);
            }
            // an error out of a mount is the mount's, so earlier error handlers do not catch it
            if (
                req._error &&
                this.skipUntil &&
                this.skipUntil.keepMount &&
                this.skipUntil.routeKey > /** @type {number} */ (req._errorKey)
            ) {
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

        // a promise only when param callbacks really run; a microtask every 300 routes keeps a
        // long chain off the stack
        const continueRoute = router._preprocessRequest(req, this.res, route);
        if (continueRoute instanceof Promise || req.routeCount % 300 === 0) {
            // .catch, so a throw inside runRoute rejects the walk; wrapped, the native pair keeps
            // the walk as receiver
            Promise.resolve(continueRoute)
                .then((resumed) => this.runRoute(resumed))
                .catch((/** @type {unknown} */ err) => this.reject(err));
            return;
        }
        return this.runRoute(continueRoute);
    }

    /**
     * Takes over a req.url a middleware assigned: an ordinary walk goes on against the new path,
     * a compiled chain hands over to ordinary routing, skipping what ran.
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
     * The same for a req.method a middleware assigned (method-override).
     *
     * @param {number} startIndex where dispatch was about to resume
     * @returns {boolean} whether this rerouted the walk itself
     */
    takeMethodRewrite(startIndex) {
        const req = this.req;
        const router = this.router;
        req._absorbMethodRewrite();
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
     * Enters the route the walk is on: a mount adjusts the path on the way in, then the callbacks
     * run through next().
     *
     * @param {true|"route"} continueRoute what _preprocessRequest decided: true to run, "route" to skip
     * @returns {void}
     */
    runRoute(continueRoute) {
        const req = this.req;
        const route = this.route;
        // a mount is stepped over while an error is in flight, on a compiled chain too
        if (route.keepMount === true && req._error) {
            return this.dispatch(this.routes.length);
        }
        if (route.use) {
            if (route.mountApp) {
                // the compiled mount route has no callback to swap req.app
                rememberApp(this, route, req);
                useApp(req, route.mountApp);
            }
            const taken = mountPrefixLength(route, req);
            // negative when the mount consumed the whole path: express invents the "/" below it,
            // see leaveHop and issue #17
            (req._stack ??= []).push(
                taken !== 0 && req._consumed + taken === req._originalPath.length ? -taken : taken
            );
            // a pathless use consumes nothing, and most middleware is pathless
            if (taken !== 0 || req.endsWithSlash) {
                req._consumed += taken;
                // req.baseUrl then joins the pieces instead of slicing
                if (taken !== 0 && req._originalPath.charCodeAt(req._consumed - 1) === 0x2f) {
                    req._mountSlash = true;
                }
                setMountedPath(req);
            }
        }
        req.next = this.next;
        // with one callback the same object, express's res.format test asserts the identity
        req._leaveRoute = route.callbacks.length > 1 ? (this.leaveRoute ??= this.stepOutOfRoute.bind(this)) : this.next;
        if (continueRoute === "route") {
            this.step("route");
        } else if (continueRoute) {
            this.step(undefined);
        } else {
            this.resolve(true);
        }
    }

    /**
     * A hop while the request carries an error, or over an error handler it cannot run.
     *
     * @param {number} kind what the callback is, one of the CALLBACK_ constants
     * @param {Function} callback
     * @returns {void}
     */
    errorHop(kind, callback) {
        const req = this.req;
        const route = this.route;
        // an error handler inside a route only sees what that route raised, as express skips a
        // route layer while an error is in flight
        const reachable = route.use
            ? req._errorKey !== undefined && route.routeKey >= req._errorKey
            : route.routeKey === req._errorKey || (route.group !== undefined && route.group === req._errorGroup);
        if (req._error && kind === CALLBACK_ERROR && reachable) {
            const out = this.router._handleError(req._error, callback, req, this.res);
            if (out instanceof Promise) {
                // a rejection moves on to the next error handler, a bare one with express's error
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
     * Leaves the route: the mount pop, the router hand-back, the hop to the next route.
     *
     * @param {boolean} isRouter next("router") rather than next("route")
     */
    leaveHop(isRouter) {
        const req = this.req;
        const route = this.route;
        if (route.use && !route.keepMount) {
            // runRoute pushed for this mount, so the stack is there and not empty
            const pushed = /** @type {number} */ (/** @type {number[]} */ (req._stack).pop());
            const taken = pushed < 0 ? -pushed : pushed;
            // a rewrite inside this middleware is taken now, the pop would revert it
            if (req.url !== req._lastUrl) {
                req._absorbUrlRewrite(taken !== 0);
                req._consumed -= taken;
                setMountedPath(req);
            } else {
                if (pushed < 0 && req._originalPath.length > req._consumed) {
                    // a rewrite below left a remainder: express strips its first character, issue #17
                    req._originalPath =
                        req._originalPath.slice(0, req._consumed) + req._originalPath.slice(req._consumed + 1);
                    req._mayFailDecode = null;
                }
                if (taken !== 0) {
                    req._consumed -= taken;
                    setMountedPath(req);
                }
            }
            restoreApp(route, req);
        }
        if (isRouter) {
            if (this.skipCheck) {
                // on a compiled chain, ordinary routing takes over after the mount; with no
                // mount the router left is the app's own
                if (this.skipUntil?.keepMount) {
                    return this.dispatch(this.routes.length);
                }
                return this.resolve(false);
            }
            return this.resolve(false);
        }
        req.routeCount++;
        // a synchronous throw out of dispatch has to reject
        try {
            return this.dispatch(this.routeIndex + 1);
        } catch (err) {
            return this.reject(err);
        }
    }

    /**
     * One hop, what next() does: nothing runs the next callback, "route" leaves the route,
     * anything else is the error.
     *
     * @param {unknown} thingamabob
     * @returns {void}
     */
    step(thingamabob) {
        const req = this.req;
        const res = this.res;
        const route = this.route;
        const router = this.router;
        if (thingamabob) {
            if (thingamabob === "route" || thingamabob === "router") {
                return this.leaveHop(thingamabob === "router");
            } else {
                req._error = thingamabob;
                req._errorKey = route.routeKey;
                req._errorGroup = route.group;
            }
        }
        const kind = route.callbackKinds[this.callbackIndex];
        const callback = route.callbacks[this.callbackIndex++];
        if (!callback) {
            return this.leaveHop(false);
        }
        // the routes a compiled chain already ran, a mount included
        if (!this.skipCheck && this.skipUntil && this.skipUntil.routeKey >= route.routeKey) {
            return this.step(undefined);
        }
        // a mount is stepped over while an error is in flight, as express's Layer#handleError
        // hands it past a three-argument handle
        if (kind === CALLBACK_ROUTER && !req._error) {
            if (callback._isApplication) {
                rememberApp(this, route, req);
                useApp(req, callback);
            }
            const pushedParams = callback._settings.mergeParams;
            if (pushedParams) {
                (req._paramStack ??= []).push(req.params);
            }
            // express restores req.params when a router hands back
            const parentParams = req.params;
            // each router answers OPTIONS with its own verbs, the list is per router
            const parentMethods = req._matchedMethods;
            if (parentMethods !== null) {
                req._matchedMethods = new Set();
            }
            callback
                ._routeRequest(req, res, 0)
                .then((/** @type {RouteEntry|false} */ routed) => {
                    if (pushedParams) {
                        /** @type {Record<string, any>[]} */ (req._paramStack).pop();
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
                    if (req._isOptions && childMethods !== null && childMethods.size && !req._error) {
                        // answered as the router hands back; a throw walks on to the error handlers
                        try {
                            router._sendOptionsReply(req, res, childMethods);
                            return this.resolve(true);
                        } catch (err) {
                            return this.step(err);
                        }
                    }
                    // an error out of the mount walks on to the error handlers after it
                    this.step(undefined);
                })
                .catch((/** @type {unknown} */ err) => this.reject(err));
        } else {
            // out of line, its size pushed step past the inlining threshold
            if (req._error || kind === CALLBACK_ERROR) {
                return this.errorHop(kind, callback);
            }

            try {
                if (req._isOptions && !route.all && route.method !== "OPTIONS") {
                    const matched = /** @type {Set<string>} */ (req._matchedMethods);
                    matched.add(route.method);
                    if (route.gettable) {
                        matched.add("HEAD");
                    }
                    return this.step(undefined);
                }
                // entered only for its param callbacks, see the scan in dispatch
                if (req._isHead && !route.all && !route.gettable && route.method !== "HEAD") {
                    return this.step(undefined);
                }

                const out = callback(req, res, this.next);
                if (out instanceof Promise) {
                    // Express 5 forwards a rejected handler promise itself, a bare one with this error
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

module.exports = Walk;
