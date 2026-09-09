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
        //
        // Null here and bound on the first route that has more than one callback, which is the
        // only shape that ever reads it: a request that never meets one paid a bind for nothing
        this.leaveRoute = null;
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
        // and the same for req.method, which method-override assigns: the compiled chain was
        // picked by the verb the request arrived with, so it no longer stands for this one
        if (req.method !== req._lastMethod && this.takeMethodRewrite(startIndex)) {
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
            // every other request from matching routes it could never run. Scanned once per
            // rewrite and kept on the request: a middleware-heavy chain scanned it per hop
            const mayFailDecode = (req._mayFailDecode ??= req._originalPath.indexOf("%") !== -1);
            // frozen here, once per scan: _pathMatches reads the two flags as bare fields, and
            // calling this per route measured 0.45us of a scan of four hundred
            router._freezeRoutingFlags();
            if (routes === router._routes) {
                // the router's own table has an index over its literal routes, so the scan visits
                // the handful that could match instead of every one, see _scanFrom
                routeIndex = router._scanFrom(req, routeIndex, mayFailDecode);
            } else {
                // a compiled chain's own array, always short: the linear scan stays.
                // Written out rather than through a predicate handed to findIndexStartingFrom,
                // which was one closure per hop of every request not on a compiled chain
                const method = req.method;
                const length = routes.length;
                for (; routeIndex < length; routeIndex++) {
                    const r = routes[routeIndex];
                    // A HEAD request enters a route whose path matched even when its verb cannot
                    // serve one: express exempts HEAD from the method check ("if (!hasMethod &&
                    // method !== 'HEAD')" in router/index.js), so the layer's parameters are
                    // captured and its param() callbacks run before the route is dropped. Only
                    // asked when the router has callbacks to run, since entering a route to step
                    // straight back out of it is otherwise pure cost. runRoute steps over it.
                    if (!(
                        r.all ||
                        r.method === method ||
                        req._isOptions ||
                        (req._isHead && (r.gettable || r.paramCallbacks.size > 0))
                    )) {
                        // taken only to fail: _preprocessRequest decodes again and turns it into
                        // the error, so the handlers of a route this request cannot run never see it
                        if (mayFailDecode && router._pathMatches(r, req) && router._paramsFailToDecode(r, req)) {
                            break;
                        }
                        continue;
                    }
                    if (router._pathMatches(r, req)) {
                        // matched, and then stepped over: a body parser this request gets nothing
                        // out of costs a hop and answers with next() at the end of it
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
     * Takes over a req.method a middleware assigned, which method-override is written to do. The
     * ordinary scan reads req.method per route and is right from the next hop on; a compiled chain
     * was chosen by the method µWS dispatched on, so ordinary routing takes over from the top the
     * way a url rewrite does.
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
     * Enters the route the walk is on: a mount adjusts req.url, req.path and the mount stack on the
     * way in, and then the route's callbacks run one after another through next().
     *
     * @param {any} continueRoute what _preprocessRequest decided: true to run, "route" to skip
     */
    runRoute(continueRoute) {
        const req = this.req;
        const route = this.route;
        // A compiled chain walks into a mount rather than entering it, so the rule above needs
        // saying here as well: everything after this marker is inside the mount, and a mount is
        // stepped over while an error is in flight. Leaving the chain is what running out of it
        // already means, and ordinary routing takes over after the mount.
        if (route.keepMount === true && req._error) {
            return this.dispatch(this.routes.length);
        }
        if (route.use) {
            if (route.mountApp) {
                // optimized chain: normal dispatch swaps req.app when it enters a mounted
                // Application, but the compiled mount route has no callback to do it
                rememberApp(this, route, req);
                useApp(req, route.mountApp);
            }
            const taken = mountPrefixLength(route, req);
            // pushed negative when this mount consumes the whole remaining path: express invents
            // the "/" the routes below see, and the pop has to know, see leaveHop and issue #17
            (req._stack ??= []).push(
                taken !== 0 && req._consumed + taken === req._originalPath.length ? -taken : taken
            );
            // a use with no path consumes nothing, so everything below would work out the values
            // that are already there. Only skipped without a trailing slash, where the rules about
            // one cannot bite. An application is mostly pathless middleware, and this is per hop
            if (taken !== 0 || req.endsWithSlash) {
                req._consumed += taken;
                // a mount that took a trailing slash: req.baseUrl then has to join the pieces
                // rather than slice the path, which is the slower half of its getter
                if (taken !== 0 && req._originalPath.charCodeAt(req._consumed - 1) === 0x2f) {
                    req._mountSlash = true;
                }
                setMountedPath(req);
            }
        }
        req.next = this.next;
        // the same step when the route has one callback, and then it has to be the same object:
        // express hands res.format's handlers the next its own layer received, and its test asserts
        // that identity. With more than one callback the two differ for real, and what express
        // hands over is the one that leaves the route
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
     * Leaves the route the walk is on: the mount pop, the router hand-back, and the hop to the
     * route after. Out of step so the commonest hop, callbacks exhausted by a plain next(), goes
     * here without re-running step's prologue and compares.
     *
     * @param {boolean} isRouter next("router") rather than next("route")
     */
    leaveHop(isRouter) {
        const req = this.req;
        const route = this.route;
        if (route.use && !route.keepMount) {
            const pushed = req._stack.pop();
            const taken = pushed < 0 ? -pushed : pushed;
            // a rewrite done inside this middleware is taken now: the pop below recomputes
            // req.url from the original path and would silently revert it. The slashAdded
            // mangle belongs to the mount that consumed a prefix, not to a pathless use
            if (req.url !== req._lastUrl) {
                req._absorbUrlRewrite(taken !== 0);
                req._consumed -= taken;
                setMountedPath(req);
            } else {
                if (pushed < 0 && req._originalPath.length > req._consumed) {
                    // a rewrite below this mount left a remainder where entry had none: express
                    // strips the first character of it when it rejoins, see issue #17
                    req._originalPath =
                        req._originalPath.slice(0, req._consumed) + req._originalPath.slice(req._consumed + 1);
                    req._mayFailDecode = null;
                }
                if (taken !== 0) {
                    // a pathless use consumed nothing and rewrote nothing, so the recompute would
                    // write back the very values it reads
                    req._consumed -= taken;
                    setMountedPath(req);
                }
            }
            restoreApp(route, req);
        }
        if (isRouter) {
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
        // skipping routes we already went through via optimized path. Before the Router branch
        // below and not after it: a mount whose chain was compiled has already run, and running it
        // again would answer from inside the router a request that had just left it
        if (!this.skipCheck && this.skipUntil && this.skipUntil.routeKey >= route.routeKey) {
            return this.step(undefined);
        }
        // A mounted router or application is stepped over while an error is in flight. Its handle
        // takes three arguments, so express's Layer#handleError hands the error straight on without
        // entering it: what a mount catches is what it raised itself. Entering it ran the error
        // handlers written inside the mount, and left req.app pointing at a mounted application,
        // whose settings then answered. A 500 carried an ETag under app.set("etag", false).
        if (kind === CALLBACK_ROUTER && !req._error) {
            if (callback._isApplication) {
                rememberApp(this, route, req);
                useApp(req, callback);
            }
            const pushedParams = callback._settings.mergeParams;
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
                    if (req._isOptions && childMethods.size && !req._error) {
                        // OPTIONS routing is different, it stops in the router if matched.
                        // Express answers as the router hands back, so a throw while answering,
                        // a head already written being the way, walks on to later error handlers
                        try {
                            router._sendOptionsReply(req, res, childMethods);
                            return this.resolve(true);
                        } catch (err) {
                            return this.step(err);
                        }
                    }
                    // An error carried out of the mount is not answered by the automatic reply, and
                    // stopping here handed it to the default page: express walks on to the error
                    // handlers written after the mount, for OPTIONS as for any other method.
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
                // entered only so its param callbacks could run, see the scan in dispatch: the verb
                // cannot serve a HEAD, so nothing here answers it
                if (req._isHead && !route.all && !route.gettable && route.method !== "HEAD") {
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

module.exports = Walk;
