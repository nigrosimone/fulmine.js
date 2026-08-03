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
    findIndexStartingFrom,
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
const { isNodeRequest, serveNodeRequest } = require("./node-shim.js");

const resCodes = {},
    resDecMethods = ["set", "setHeader", "header", "send", "end", "append", "status"];
for (const method of resDecMethods) {
    resCodes[method] = Response.prototype[method].toString();
}

let routeKey = 0;

const methods = [
    "all",
    "post",
    "put",
    "delete",
    "patch",
    "options",
    "head",
    "trace",
    "connect",
    "checkout",
    "copy",
    "lock",
    "mkcol",
    "move",
    "purge",
    "propfind",
    "proppatch",
    "search",
    "subscribe",
    "unsubscribe",
    "report",
    "mkactivity",
    "mkcalendar",
    "checkout",
    "merge",
    "m-search",
    "notify",
    "subscribe",
    "unsubscribe",
    "search",
    "query"
];
/**
 * Hands the request, and the response with it, to the app that is about to handle it.
 *
 * Express does this by re-parenting both objects onto that app's own request and response
 * prototypes, which carry `app` as a property, so a mounted sub-app's settings decide what its
 * responses do: its "etag fn", its "json spaces", its "x-powered-by". Only the request was being
 * swapped here, so a sub-app's settings reached its handlers and never its answers.
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

const supportedUwsMethods = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "CONNECT", "TRACE"]);

const regExParam = /:(\w+)/g;

// Why this file names its internals with an underscore instead of making them truly private.
//
// express.Router() does not hand back a Router. It hands back a function with the router's own
// properties copied onto it and the router's prototype set behind it, so that the router can be
// used as middleware by calling it. Object.assign copies properties, and a # field is not a
// property: it is an internal slot keyed by the class, and the function is not an instance of that
// class however its prototype is set. Convert _routes to #routes and every callable router throws
// "Cannot read private member" the first time a method touches it.
//
// So: # is for a class whose instances are always real instances, which here means Request,
// Response and Application. Everything on Router, and everything one class reads off another's
// instance such as req._opPath, stays an underscore because it has to.

// one intermediate prototype per class, built the first time a callable of that class is made
const callablePrototypes = new WeakMap();

/**
 * The prototype a callable router or app is given: the class's own, with the handful of things a
 * function is expected to have put back.
 *
 * Setting a function's prototype to a class prototype takes Function.prototype out of its chain,
 * and with it apply, call and bind. A function without apply is not something node will emit a
 * request to: `http.createServer(app)` failed with "handler.apply is not a function" on Node 24,
 * where Node 26 happened to call the listener another way and let it pass. Anything doing
 * `fn.call(...)` or `fn.bind(...)` with a router had the same hole, and has had it for as long as
 * express.Router() has handed back a function.
 *
 * An intermediate object rather than copying the methods onto the function, so that the class
 * prototype stays in the chain: express.application is that prototype, and adding a method to it
 * has to reach apps that already exist.
 *
 * constructor is deliberately not among the names taken from Function.prototype. It is Function
 * there, and code here asks `this.constructor.name === "Application"`.
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
    for (const name of ["apply", "call", "bind", "toString"]) {
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
     * This router as middleware: a function that routes the request and calls next() when nothing
     * in it answered. What express.Router() hands back, since a router has to be callable to be
     * usable as middleware.
     *
     * Not a Router. It is a function carrying the router's own properties with the router's
     * prototype behind it, which is why nothing in this file may be a # field.
     *
     * The state is shared rather than copied: every property here is the same object the instance
     * held, so the two are one router seen twice. Nothing keeps the instance afterwards.
     *
     * An app is deliberately not made callable this way, for the reason written next to the
     * factory at the end of application.js.
     *
     * @returns {any} the callable
     */
    _asCallable() {
        // the prototype it is about to be given is the one carrying handle(), which nothing can
        // see from here
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
     * Routes a request through this router, the way Express's app.handle and router.handle do.
     *
     * next is called when no route answered, so a router that matches nothing hands the request
     * back to whatever is running it rather than ending it. Without one, an unmatched request is
     * simply left alone.
     *
     * @param {any} req
     * @param {any} res
     * @param {(err?: any) => void} [next]
     * @returns {Promise<void>}
     */
    async handle(req, res, next) {
        // A request from node's own HTTP server rather than from uWS, which is what arrives when
        // the app was handed to http.createServer or to anything that does that for you. It is
        // served through a shim rather than refused, since refusing is what made the app unusable
        // as a request listener at all.
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

        if (typeof pattern === "string") {
            if (pattern === "/*") {
                return true;
            }
            if (path === "") {
                path = "/";
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
     * become several routes sharing the callbacks, as Express allows.
     *
     * Paths are normalised here rather than at match time: a trailing slash is dropped unless
     * strict routing is on, a bare "*" becomes "/{*splat}", and anything that cannot be compared as
     * a plain string is compiled into a regular expression and marked complex.
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
                routeKey: routeKey++,
                // the router this was registered on. Ordinary dispatch is done by that router, so
                // it could ask itself, but an optimized chain is walked by the app whatever it
                // contains, and param() callbacks belong to the router that declared them
                owner: this,
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

    // if route is a simple string, its possible to pre-calculate its path
    // and then create a native uWS route for it, which is much faster
    /**
     * The chain a request would walk to reach this route, or false when that cannot be known ahead
     * of time. Everything registered before the route that could also match it has to be in the
     * chain, in order: the native router jumps straight to the route, and the middleware in front
     * of it still has to run.
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
                                keepMount: true,
                                // mounted sub-apps become req.app during their dispatch, like express
                                mountApp:
                                    route.callbacks[0].constructor.name === "Application"
                                        ? route.callbacks[0]
                                        : undefined
                            }
                        ]);
                    }
                    // canBeOptimizedWithParams and not canBeOptimized: a path whose parameters are
                    // whole segments is one µWS matches itself, and "/users/:id" is the commonest
                    // route shape there is. The chain below is what keeps the order right, since
                    // µWS picks by specificity where Express picks by registration order: whichever
                    // route µWS lands on, the chain computed for it runs everything that could have
                    // matched first, in order.
                } else if (
                    (canBeOptimized(route.path) ||
                        (canBeOptimizedWithParams(route.path) &&
                            // inside a mounted router, only when nothing after it could match.
                            // app.param() and router.param() used to be an exception here as well,
                            // since the chain is walked by the app and the app would have consulted
                            // its own callbacks; every route carries its router now, so the right
                            // ones run and a router with param callbacks is optimized like any other
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
     * Registers one route on the native uWS router, along with the chain it has to walk first.
     *
     * A GET is registered for HEAD as well, and unless strict routing is on the path is registered
     * with a trailing slash too. A handler simple enough to be read at registration time is
     * compiled into a declarative response, but only for its own method: HEAD keeps the real
     * handler, since a response written once cannot leave its body out.
     *
     * @param {any} route
     * @param {any[]} optimizedPath the chain from _optimizeRoute
     */
    /**
     * Whether something registered after this route, in the same router, could also match a path
     * this route matches.
     *
     * It decides whether a route with a parameter inside a mounted router may go to µWS. When a
     * native chain runs out and hands back to ordinary routing, it resumes after the mount in the
     * parent rather than inside the router, so a sibling that would have matched next is lost. A
     * parameter matches many paths, so it has many possible siblings, where a literal has almost
     * none.
     *
     * Conservative where it has to be: a mount, or a pattern of a shape this cannot reason about,
     * counts as an overlap without further questions. Two paths µWS could match itself are compared
     * segment by segment instead, which is what makes a router of /orders/:id, /orders/:id/items and
     * /invoices/:id routes native rather than only its last route.
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
            // for a route optimized through a mounted router, falling back to normal routing must resume
            // after the mount in the parent (like normal dispatch does), not after the router's leaf route.
            // the leaf can have a lower routeKey than the parent's own middlewares (e.g. when the router is
            // required from another module), which would otherwise let a pre-mount error handler catch an
            // error thrown inside the router.
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
            (route.owner ?? this)._paramCallbacks.size === 0 && // a param callback has to run, and this answers without running anything
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
            response.statusCode = 500;
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
        if (path.endsWith("/")) {
            path = path.slice(0, -1);
        }
        const match = pattern.exec(path);
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
        // and req.optimizedParams, not the route flag alone: the flag says this route was registered
        // natively, while the values are only there when this request actually came in through that
        // registration. A request that reached the same route the slow way has none, and would
        // otherwise be handed an empty params object.
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

        // the route's own router, not whoever is running the chain: an optimized chain is walked by
        // the app even when it ends in a mounted router's route, and that router's param callbacks
        // are the ones Express would run there
        const paramCallbacks = (route.owner ?? this)._paramCallbacks;
        if (paramCallbacks.size > 0) {
            // known issue, not introduced here: an async executor swallows anything it throws,
            // because the rejection has nowhere to go once the promise is already constructed.
            // app.param() callbacks that throw synchronously are therefore lost. Fixing it means
            // restructuring this into an async function that returns a promise, which changes
            // when the param callbacks run relative to the route, so it needs its own change.
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
            this._dispatchRoute(req, res, startIndex, routes, skipCheck, skipUntil, resolve, reject);
        });
    }

    // walks this router's chain for a single request. moving on to the next route is a plain call that
    // carries the same resolve, so a chain of N middlewares costs one promise instead of N nested ones
    // that each have to be adopted back up the chain
    /**
     * Finds the next route that matches and runs it, carrying the same resolve and reject the whole
     * way rather than nesting a promise per hop. next() calls this again for the route after, so a
     * chain of N middlewares costs one promise instead of N that each have to be adopted back up.
     *
     * @param {any} req
     * @param {any} res
     * @param {number} startIndex where to resume the scan
     * @param {any[]} routes
     * @param {boolean} skipCheck take the route at startIndex without matching it, which is how an
     *   already-decided chain is walked
     * @param {any} skipUntil route to resume after when this chain runs out, or undefined
     * @param {(value: any) => void} resolve
     * @param {(err: any) => void} reject
     */
    _dispatchRoute(req, res, startIndex, routes, skipCheck, skipUntil, resolve, reject) {
        const routeIndex = skipCheck
            ? startIndex
            : findIndexStartingFrom(
                  routes,
                  (r) =>
                      (r.all || r.method === req.method || req._isOptions || (r.gettable && req._isHead)) &&
                      this._pathMatches(r, req),
                  startIndex
              );
        const route = routes[routeIndex];
        if (!route) {
            if (!skipCheck) {
                // on normal unoptimized routes, if theres no match then there is no route
                return resolve(false);
            }
            // on optimized routes, there can be more routes, so we have to use unoptimized routing and skip until we find route we stopped at
            useApp(req, this); // restore app in case the optimized path swapped it to a mounted sub-app
            // and the mount itself, if the chain went into a mounted router and never came out. Its
            // mount entries are marked keepMount so that nothing pops them while the chain runs,
            // which leaves req.url, req.path and req.baseUrl relative to the mount. What resumes
            // here is the app's own routing, where the path is the whole path again: a request for
            // /alone/skip that fell out of the router mounted at /alone must not be offered to the
            // app's routes as /skip.
            if (req._stack.length > 0) {
                req._stack.length = 0;
                req._stackMounted = 0;
                req.path = req._originalPath;
                req.url = req._originalPath + req.urlQuery;
                req._opPath =
                    req.endsWithSlash && req._originalPath !== "/" && !this.get("strict routing")
                        ? req._originalPath.slice(0, -1)
                        : req._originalPath;
            }
            // an error that propagated out of a mounted router's optimized chain is attributed to the mount
            // (like normal dispatch does when a sub-router returns an error), so parent error handlers declared
            // before the mount don't catch it - the router's leaf can have a lower routeKey than those handlers
            if (req._error && skipUntil && skipUntil.keepMount && skipUntil.routeKey > req._errorKey) {
                req._errorKey = skipUntil.routeKey;
            }
            return this._dispatchRoute(req, res, 0, this._routes, false, skipUntil, resolve, reject);
        }

        // _preprocessRequest only returns a promise when there are param callbacks, so the common case
        // stays fully synchronous. going through a microtask also resets max call stack size, which a long
        // chain of routes would otherwise blow, so force one every 300 routes
        // routeCount starts at 1 so the first route of a request (fresh stack) takes the sync path
        const continueRoute = this._preprocessRequest(req, res, route);
        if ((route.owner ?? this)._paramCallbacks.size !== 0 || req.routeCount % 300 === 0) {
            Promise.resolve(continueRoute).then(
                (resumed) =>
                    this._runRoute(req, res, routeIndex, route, routes, skipCheck, skipUntil, resolve, reject, resumed),
                reject
            );
            return;
        }
        return this._runRoute(
            req,
            res,
            routeIndex,
            route,
            routes,
            skipCheck,
            skipUntil,
            resolve,
            reject,
            continueRoute
        );
    }

    /**
     * Runs one route's callbacks, one after another through next(). A mount adjusts req.url,
     * req.path and the mount stack on the way in, and puts them back if next("route") leaves it.
     *
     * @param {any} req
     * @param {any} res
     * @param {number} routeIndex
     * @param {any} route
     * @param {any[]} routes
     * @param {boolean} skipCheck
     * @param {any} skipUntil
     * @param {(value: any) => void} resolve
     * @param {(err: any) => void} reject
     * @param {any} continueRoute
     */
    _runRoute(req, res, routeIndex, route, routes, skipCheck, skipUntil, resolve, reject, continueRoute) {
        let callbackindex = 0;
        const strictRouting = this.get("strict routing");
        if (route.use) {
            if (route.mountApp) {
                // optimized chain: normal dispatch swaps req.app when it enters a mounted Application,
                // but the compiled mount route has no callback to do it, so swap it here
                useApp(req, route.mountApp);
            }
            req._stack.push(route.path);
            if (route.path !== "") {
                req._stackMounted++;
            }
            const fullMountpath = this.getFullMountpath(req);
            req._opPath =
                fullMountpath !== EMPTY_REGEX ? req._originalPath.replace(fullMountpath, "") : req._originalPath;
            if (req.endsWithSlash && req._opPath[req._opPath.length - 1] !== "/") {
                if (strictRouting) {
                    req._opPath += "/";
                } else {
                    req._opPath = req._opPath.slice(0, -1);
                }
            }
            req.url = req._opPath + req.urlQuery;
            req.path = req._opPath;
            if (req._opPath === "") {
                req.url = "/";
                req.path = "/";
            }
        }
        // plain (non-async) function: an async next() would allocate an unconsumed promise
        // on every middleware/handler step of every request
        const next = (thingamabob) => {
            if (thingamabob) {
                if (thingamabob === "route") {
                    if (route.use && !route.keepMount) {
                        if (req._stack.pop() !== "") {
                            req._stackMounted--;
                        }

                        const poppedMountpath = req._stack.length > 0 ? this.getFullMountpath(req) : EMPTY_REGEX;
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
                    // _dispatchRoute is a plain function, so a synchronous throw would escape here instead
                    // of rejecting, like it used to when this recursed through the async _routeRequest
                    try {
                        return this._dispatchRoute(
                            req,
                            res,
                            routeIndex + 1,
                            routes,
                            skipCheck,
                            skipUntil,
                            resolve,
                            reject
                        );
                    } catch (err) {
                        return reject(err);
                    }
                } else {
                    req._error = thingamabob;
                    req._errorKey = route.routeKey;
                }
            }
            const callback = route.callbacks[callbackindex++];
            if (!callback) {
                return next("route");
            }
            // skipping routes we already went through via optimized path. Before the Router branch
            // below and not after it: a mount whose chain was compiled has already run, and running
            // it again would answer from inside the router a request that had just left it
            if (!skipCheck && skipUntil && skipUntil.routeKey >= route.routeKey) {
                return next();
            }
            if (callback instanceof Router) {
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
                    if (routed) return resolve(true);
                    if (req._isOptions && req._matchedMethods.size) {
                        // OPTIONS routing is different, it stops in the router if matched
                        return resolve(false);
                    }
                    next();
                });
            } else {
                // handle errors and error handlers
                if (req._error || callback.length === 4) {
                    if (req._error && callback.length === 4 && route.routeKey >= req._errorKey) {
                        return this._handleError(req._error, callback, req, res);
                    } else {
                        return next();
                    }
                }

                try {
                    // handling OPTIONS method
                    if (req._isOptions && !route.all && route.method !== "OPTIONS") {
                        req._matchedMethods.add(route.method);
                        if (route.gettable) {
                            req._matchedMethods.add("HEAD");
                        }
                        return next();
                    }

                    const out = callback(req, res, next);
                    if (out instanceof Promise) {
                        // Express 5 forwards a rejected handler promise to the error middleware on
                        // its own, so there is nothing left for the "catch async errors" setting or
                        // for express-async-errors to opt into
                        out.catch((err) => {
                            req._error = err;
                            req._errorKey = route.routeKey;
                            return next();
                        });
                    }
                } catch (err) {
                    req._error = err;
                    req._errorKey = route.routeKey;
                    return next();
                }
            }
        };
        req.next = next;
        if (continueRoute === "route") {
            next("route");
        } else if (continueRoute) {
            next();
        } else {
            resolve(true);
        }
    }

    /**
     * Mounts middleware, or a whole router, at a path.
     *
     * The path is optional: `use(fn)` and `use([fn, fn])` mount at the root. A mounted route
     * matches the path and everything under it, which is what separates it from `all()`.
     *
     * Mounting a Router sets its mountpath and parent and emits 'mount' on it.
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
     * How a request that nothing answered ends: with the error it is carrying, with the automatic
     * OPTIONS reply, or with a 404.
     *
     * Three ways in reach this and they have to agree: the native chain, the catch-all handler the
     * app registers, and the shim that serves a request from node's own server. The third had no
     * OPTIONS reply at all until this was one method, which is what a request through supertest
     * gets, so `app.options` answered 404 there and nowhere else.
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

// The verb methods, on the prototype rather than built per instance in the constructor.
//
// They have to be on the prototype for a callable router to be one router. As own arrows they
// closed over the instance they were built on, so the copy _asCallable() makes answered with that
// instance: express.Router().post("/a", h) handed back the object the callable was copied from,
// and a chain carried on against something nobody else was holding. Sharing the same _routes array
// hid it, but only until something replaced an array instead of pushing to one.
//
// It costs nothing to prefer, either. The list is long and there was one closure per name for
// every router and every app in the process; now there is one per name for the process.
for (const method of methods) {
    module.exports.prototype[method] = function (path, ...callbacks) {
        return this.createRoute(method, path, this, ...callbacks);
    };
}
