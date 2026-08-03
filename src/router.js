/*
Copyright 2024 dimden.dev
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

const {
    patternToRegex,
    getPatternMeta,
    decodeParam,
    needsConversionToRegex,
    canBeOptimized,
    canBeOptimizedWithParams,
    pathsCanOverlap,
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

const resCodes = {},
    resDecMethods = ["set", "setHeader", "header", "send", "end", "append", "status"];
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
        this.routeIndex = 0;
        this.route = null;
        this.callbackIndex = 0;
        // bound, not wrapped in an arrow: an arrow forwarding into step() is one more call on every
        // hop, and it measured 495 microseconds per thousand requests of nothing else
        this.next = this.step.bind(this);
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
        let routeIndex = startIndex;
        if (!this.skipCheck) {
            // written out rather than through a predicate handed to findIndexStartingFrom, which
            // was one closure per hop of every request not on a compiled chain
            for (; routeIndex < routes.length; routeIndex++) {
                const r = routes[routeIndex];
                if (
                    (r.all || r.method === req.method || req._isOptions || (r.gettable && req._isHead)) &&
                    router._pathMatches(r, req)
                ) {
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
            if (req._stack.length > 0) {
                req._stack.length = 0;
                req._stackMounted = 0;
                req.path = req._originalPath;
                req.url = req._originalPath + req.urlQuery;
                req._opPath =
                    req.endsWithSlash && req._originalPath !== "/" && !router.get("strict routing")
                        ? req._originalPath.slice(0, -1)
                        : req._originalPath;
            }
            // an error out of a mount is attributed to the mount, so error handlers declared before
            // it do not catch it, as in ordinary dispatch
            if (req._error && this.skipUntil && this.skipUntil.keepMount && this.skipUntil.routeKey > req._errorKey) {
                req._errorKey = this.skipUntil.routeKey;
            }
            this.routes = router._routes;
            this.skipCheck = false;
            return this.dispatch(0);
        }

        this.routeIndex = routeIndex;
        this.route = route;
        this.callbackIndex = 0;

        // _preprocessRequest returns a promise only when there are param callbacks, so the common
        // case stays synchronous. A microtask every 300 routes resets the stack, which a long chain
        // would otherwise blow
        const continueRoute = router._preprocessRequest(req, this.res, route);
        if (route.paramCallbacks.size !== 0 || req.routeCount % 300 === 0) {
            Promise.resolve(continueRoute).then((resumed) => this.runRoute(resumed), this.reject);
            return;
        }
        return this.runRoute(continueRoute);
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
        const router = this.router;
        if (route.use) {
            if (route.mountApp) {
                // optimized chain: normal dispatch swaps req.app when it enters a mounted
                // Application, but the compiled mount route has no callback to do it
                useApp(req, route.mountApp);
            }
            req._stack.push(route.path);
            // a use with no path consumes nothing, so everything below would work out the values
            // that are already there. Only skipped without a trailing slash, where the rules about
            // one cannot bite. An application is mostly pathless middleware, and this is per hop
            if (route.path !== "" || req.endsWithSlash) {
                if (route.path !== "") {
                    req._stackMounted++;
                }
                const fullMountpath = router.getFullMountpath(req);
                req._opPath =
                    fullMountpath !== EMPTY_REGEX ? req._originalPath.replace(fullMountpath, "") : req._originalPath;
                if (req.endsWithSlash && req._opPath[req._opPath.length - 1] !== "/") {
                    req._opPath = router.get("strict routing") ? req._opPath + "/" : req._opPath.slice(0, -1);
                }
                req.url = req._opPath + req.urlQuery;
                req.path = req._opPath;
                if (req._opPath === "") {
                    req.url = "/";
                    req.path = "/";
                }
            }
        }
        req.next = this.next;
        if (continueRoute === "route") {
            this.step("route");
        } else if (continueRoute) {
            this.step(undefined);
        } else {
            this.resolve(true);
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
            if (thingamabob === "route") {
                if (route.use && !route.keepMount) {
                    if (req._stack.pop() !== "") {
                        req._stackMounted--;
                    }

                    const strictRouting = router.get("strict routing");
                    const poppedMountpath = req._stack.length > 0 ? router.getFullMountpath(req) : EMPTY_REGEX;
                    req._opPath =
                        poppedMountpath !== EMPTY_REGEX
                            ? req._originalPath.replace(poppedMountpath, "")
                            : req._originalPath;
                    if (strictRouting) {
                        if (req.endsWithSlash && req._opPath[req._opPath.length - 1] !== "/") {
                            req._opPath += "/";
                        }
                    }
                    req.url = req._opPath + req.urlQuery;
                    req.path = req._opPath;
                    if (req._opPath === "") {
                        req.url = "/";
                        req.path = "/";
                    }
                    if (
                        !strictRouting &&
                        req.endsWithSlash &&
                        req._originalPath !== "/" &&
                        req._opPath[req._opPath.length - 1] === "/"
                    ) {
                        req._opPath = req._opPath.slice(0, -1);
                    }
                    if (req.app.parent && route.callbacks[0]?.constructor.name === "Application") {
                        useApp(req, req.app.parent);
                    }
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
                useApp(req, callback);
            }
            if (callback.settings.mergeParams) {
                req._paramStack.push(req.params);
            }
            if (
                callback.settings["strict routing"] &&
                req.endsWithSlash &&
                req._opPath[req._opPath.length - 1] !== "/"
            ) {
                req._opPath += "/";
            }
            callback._routeRequest(req, res, 0).then((routed) => {
                if (req._error) {
                    req._errorKey = route.routeKey;
                }
                if (routed) return this.resolve(true);
                if (req._isOptions && req._matchedMethods.size) {
                    // OPTIONS routing is different, it stops in the router if matched
                    return this.resolve(false);
                }
                this.step(undefined);
            });
        } else {
            // handle errors and error handlers
            if (req._error || kind === CALLBACK_ERROR) {
                if (req._error && kind === CALLBACK_ERROR && route.routeKey >= req._errorKey) {
                    return router._handleError(req._error, callback, req, res);
                } else {
                    return this.step(undefined);
                }
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
                    // express-async-errors to opt into
                    out.catch((err) => {
                        req._error = err;
                        req._errorKey = route.routeKey;
                        return this.step(undefined);
                    });
                }
            } catch (err) {
                req._error = err;
                req._errorKey = route.routeKey;
                return this.step(undefined);
            }
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
function useApp(req, app) {
    req.app = app;
    if (req.res) {
        req.res.app = app;
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

const regExParam = /:(\w+)/g;

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
 * @param {any} err
 * @returns {string}
 */
function generateErrorPageHtml(err) {
    return (
        `<!DOCTYPE html>\n` +
        `<html lang="en">\n` +
        `<head>\n` +
        `<meta charset="utf-8">\n` +
        `<title>Error</title>\n` +
        `</head>\n` +
        `<body>\n` +
        `<pre>${err?.stack ?? err}</pre>\n` +
        `</body>\n` +
        `</html>\n`
    );
}

module.exports = class Router extends EventEmitter {
    parent;

    listenCalled;

    uwsApp;

    /**
     * @param {object} [settings] router options. caseSensitive and strict are accepted under the
     *   names Express's Router takes, and stored under the setting names the rest of the code reads
     */
    constructor(settings = {}) {
        super();

        this._paramCallbacks = new Map();
        this._mountpathCache = new Map();
        this._routes = [];
        // an array when mounted on several paths at once, as Express allows
        /** @type {string|string[]} */
        this.mountpath = "/";
        this.settings = settings;
        this._request = Request;
        this._response = Response;
        this.request = this._request.prototype;
        this.response = this._response.prototype;

        if (typeof settings.caseSensitive !== "undefined") {
            this.settings["case sensitive routing"] = settings.caseSensitive;
            delete this.settings.caseSensitive;
        }
        if (typeof settings.strict !== "undefined") {
            this.settings["strict routing"] = settings.strict;
            delete this.settings.strict;
        }

        if (typeof this.settings["case sensitive routing"] === "undefined") {
            this.settings["case sensitive routing"] = true;
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
        if (this.constructor.name === "Application") {
            useApp(req, this);
        }
        const routed = await this._routeRequest(req, res, 0);
        if (!routed && next) {
            next();
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
        // without walking the whole stack on every hop
        if (!req._stack.length || req._stackMounted === 0) {
            return EMPTY_REGEX;
        }
        const fullStack = req._stack.join("");
        let fullMountpath = this._mountpathCache.get(fullStack);
        if (!fullMountpath) {
            fullMountpath = patternToRegex(fullStack, true);
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
        let path = req._opPath;
        let pattern = route.pattern;

        if (req.endsWithSlash && path.endsWith("/") && !this.get("strict routing")) {
            path = path.slice(0, -1);
        }
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
            if (!this.get("case sensitive routing")) {
                path = path.toLowerCase();
                pattern = pattern.toLowerCase();
            }
            return pattern === path;
        }
        if (pattern === EMPTY_REGEX) {
            return true;
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
        callbacks = callbacks.flat();
        const paths = Array.isArray(path) ? path : [path];
        const routes = [];
        for (let path of paths) {
            if (!this.get("strict routing") && typeof path === "string" && path.endsWith("/") && path !== "/") {
                path = path.slice(0, -1);
            }
            if (path === "*") {
                path = "/{*splat}";
            }
            const route = {
                method: method === "USE" ? "ALL" : method,
                path,
                pattern:
                    method === "USE" || needsConversionToRegex(path) ? patternToRegex(path, method === "USE") : path,
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
                routeKey: routeKey++,
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
                typeof route.path === "string" &&
                (route.path.includes(":") || route.path.includes("*") || route.path.includes("{")) &&
                route.pattern instanceof RegExp
            ) {
                route.complex = true;
            }
            routes.push(route);
        }
        this._routes.push(...routes);

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
                    continue;
                }
            }

            // check if the paths match
            if (
                (r.pattern instanceof RegExp && r.pattern.test(route.path)) ||
                (typeof r.pattern === "string" && (r.pattern === route.path || r.pattern === "/*"))
            ) {
                if (r.callbacks.some((c) => c instanceof Router)) {
                    return false; // cant optimize nested routers with matches
                }
                optimizedPath.push(r);
            }
        }
        optimizedPath.push(route);

        return optimizedPath;
    }

    /**
     * Hands every route reachable by path alone to the native uWS router, walking into mounted
     * routers and carrying their prefix down. Runs once, when the app starts listening, since it
     * needs every route to have been registered first.
     */
    _compileOptimizedRoutes() {
        if (!this.uwsApp || !this.get("case sensitive routing")) {
            return;
        }

        // pathPrefix/chainPrefix accumulate across nested sole-callback mounts
        const walk = (router, pathPrefix, chainPrefix) => {
            for (const route of router._routes) {
                if (route.use) {
                    // only sole-callback mounts
                    if (
                        !route.complex &&
                        canBeOptimized(route.path) &&
                        route.path !== "/*" &&
                        route.callbacks.length === 1 &&
                        route.callbacks[0] instanceof Router
                    ) {
                        let pathToMount = router._optimizeRoute(route, router._routes);
                        if (!pathToMount) {
                            continue;
                        }
                        pathToMount = pathToMount.slice(0, -1);
                        walk(route.callbacks[0], pathPrefix + route.path, [
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
                        ]);
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
                    const leafPath = router._optimizeRoute(route, router._routes);
                    if (!leafPath) {
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
                            continue;
                        }
                    }
                    if (pathPrefix) {
                        this._registerUwsRoute(
                            {
                                ...route,
                                path: pathPrefix + route.path,
                                pattern: pathPrefix + route.path,
                                optimizedRouter: true
                            },
                            [...chainPrefix, ...leafPath]
                        );
                    } else {
                        this._registerUwsRoute(route, leafPath);
                    }
                }
            }
        };

        walk(this, "", []);
    }

    /**
     * Wraps a uWS request and response in ours and links them, which is the first thing every
     * request does whichever path serves it.
     *
     * @param {any} res uWS response
     * @param {any} req uWS request, readable only during this call
     * @returns {{request: any, response: any}}
     */
    handleRequest(res, req) {
        const request = new this._request(req, res, this);
        const response = new this._response(res, request, this);
        request.res = response;
        response.req = request;
        res.onAborted(() => {
            /** @type {NodeJS.ErrnoException} */
            const err = new Error("Connection closed");
            err.code = "ECONNRESET";
            response.aborted = true;
            response.finished = true;
            response.socket?.emit("error", err);
        });

        return { request, response };
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
                if (pathsCanOverlap(route.path, later.path)) {
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
        let fn = async (res, req) => {
            const { request, response } = this.handleRequest(res, req);
            if (route.optimizedParams) {
                request.optimizedParams = new NullObject();
                for (let i = 0; i < route.optimizedParams.length; i++) {
                    request.optimizedParams[route.optimizedParams[i]] = req.getParameter(i);
                }
            }
            // falling back resumes after the mount, not after the router's leaf: the leaf can have a
            // lower routeKey than the parent's middlewares, and an error handler declared before the
            // mount must not catch what the router threw
            const mount = optimizedPath.find((r) => r.keepMount);
            const skipUntil = mount ?? (optimizedPath.length ? optimizedPath[optimizedPath.length - 1] : route);
            const matchedRoute = await this._routeRequest(request, response, 0, optimizedPath, true, skipUntil);
            if (!matchedRoute && !response.headersSent && !response.aborted) {
                this._endUnmatched(request, response);
            }
        };
        route.optimizedPath = optimizedPath;

        let replacedPath = route.path;
        const realFn = fn;

        // check if route is declarative
        if (
            optimizedPath.length === 1 && // must not have middlewares
            route.callbacks.length === 1 && // must not have multiple callbacks
            typeof route.callbacks[0] === "function" && // must be a function
            route.paramCallbacks.size === 0 && // a param callback has to run, and this answers without running anything
            !resDecMethods.some((method) => resCodes[method] !== this.response[method].toString()) && // must not have injected methods
            this.get("declarative responses") // must have declarative responses enabled
        ) {
            const decRes = compileDeclarative(route.callbacks[0], this);
            if (decRes) {
                fn = decRes;
            }
        } else {
            replacedPath = route.path.replace(regExParam, ":x");
        }

        this.uwsApp[method](replacedPath, fn);
        // the route's own router decides, not the app running the registration: a router created
        // with { strict: true } and mounted on an app without it does not answer /things/, and
        // registering that path here is the only way it could
        if (!(route.owner ?? this).get("strict routing") && route.path[route.path.length - 1] !== "/") {
            this.uwsApp[method](replacedPath + "/", fn);
            if (method === "get") {
                this.uwsApp.head(replacedPath + "/", realFn);
            }
        }
        if (method === "get") {
            this.uwsApp.head(replacedPath, realFn);
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
            return handler(err, request, response, (pass) => {
                delete request._error;
                delete request._errorKey;
                return request.next(pass);
            });
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
        if (!match?.groups) {
            return obj;
        }

        const groups = match.groups;
        const meta = getPatternMeta(pattern);
        if (meta === undefined) {
            // a RegExp the application supplied itself, which was never compiled here
            for (const name in groups) {
                const value = groups[name];
                if (value === undefined) {
                    continue;
                }
                obj[name] = decodeParam(value);
            }
            return obj;
        }

        // asking for each name in turn rather than walking the groups object, which is a
        // null-prototype dictionary and slow to enumerate, and reading the wildcard answer that was
        // worked out when the pattern was compiled instead of searching an array for it
        const { paramNames, isWildcard } = meta;
        for (let i = 0, len = paramNames.length; i < len; i++) {
            const name = paramNames[i];
            const value = groups[name];
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
                req._error = err;
                req._errorKey = route.routeKey;
                return "route";
            }
        } else if (route.complex) {
            let path = req._originalPath;
            if (req._stack.length > 0) {
                const fullMountpath = this.getFullMountpath(req);
                if (fullMountpath !== EMPTY_REGEX) {
                    path = path.replace(fullMountpath, "");
                }
            }
            try {
                req.params = this._extractParams(route.pattern, path);
            } catch (err) {
                // a parameter that will not decode. Express throws out of the match and lets the
                // error reach the error handler, which answers 400, so the route is skipped rather
                // than run with a value nobody can read.
                req._error = err;
                req._errorKey = route.routeKey;
                return "route";
            }
            if (req._paramStack.length > 0) {
                for (const params of req._paramStack) {
                    req.params = Object.assign(Object.create(null), params, req.params);
                }
            }
        } else {
            req.params = {};
            if (req._paramStack.length > 0) {
                for (const params of req._paramStack) {
                    req.params = Object.assign(Object.create(null), params, req.params);
                }
            }
        }

        // the route's own router's callbacks: an optimized chain is walked by the app even when it
        // ends in a mounted router's route
        const paramCallbacks = route.paramCallbacks;
        if (paramCallbacks.size > 0) {
            // known issue: an async executor swallows what it throws, so a param callback that
            // throws synchronously is lost. Fixing it moves when the callbacks run
            // eslint-disable-next-line no-async-promise-executor
            return new Promise(async (resolve) => {
                for (const param in req.params) {
                    const pcs = paramCallbacks.get(param);
                    // built here rather than for every request, since only an application using
                    // app.param() ever reaches this line
                    if (pcs && !req._gotParams?.has(param)) {
                        (req._gotParams ??= new Set()).add(param);
                        for (let i = 0, len = pcs.length; i < len; i++) {
                            const fn = pcs[i];
                            await /** @type {Promise<void>} */ (
                                new Promise((resolveRoute) => {
                                    const next = (thingamabob) => {
                                        if (thingamabob) {
                                            if (thingamabob === "route") {
                                                return resolve("route");
                                            } else {
                                                req._error = thingamabob;
                                                req._errorKey = route.routeKey;
                                            }
                                        }
                                        return resolveRoute();
                                    };
                                    req.next = next;
                                    fn(req, res, next, req.params[param], param);
                                })
                            );
                        }
                    }
                }

                resolve(true);
            });
        }
        return true;
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
     * @param {string|string[]|Function|Router|Array<Function|Router>} [path] mount path, or the
     *   first handler
     * @param {...(Function|Router|Array<Function|Router>)} callbacks handlers, nested arrays allowed
     * @returns {this} the router, for chaining
     */
    use(path, ...callbacks) {
        if (
            typeof path === "function" ||
            path instanceof Router ||
            (Array.isArray(path) && path.every((p) => typeof p === "function" || p instanceof Router))
        ) {
            callbacks.unshift(path);
            path = "";
        }
        if (path === "/") {
            path = "";
        }
        callbacks = callbacks.flat();

        for (const callback of callbacks) {
            if (callback instanceof Router) {
                callback.mountpath = /** @type {string|string[]} */ (path);
                callback.parent = this;
                callback.emit("mount", this);
            }
        }
        this.createRoute("USE", path, this, ...callbacks);
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
        const fns = new NullObject();
        for (const method of methods) {
            fns[method] = (...callbacks) => {
                return this.createRoute(method, path, /** @type {any} */ (fns), ...callbacks);
            };
        }
        fns.get = (...callbacks) => {
            return this.createRoute("GET", path, /** @type {any} */ (fns), ...callbacks);
        };
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
            // Express 5 sorts the methods and joins them with ", ", so the header reads the same
            // regardless of the order the routes happened to be registered in
            const allowedMethods = Array.from(request._matchedMethods).sort().join(", ");
            response.setHeader("Allow", allowedMethods);
            // the router package answers this one itself, with a plain-text body, the nosniff
            // header and end() rather than send(), so no ETag comes with it
            response.setHeader("Content-Type", "text/plain");
            response.setHeader("X-Content-Type-Options", "nosniff");
            response.end(allowedMethods);
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
