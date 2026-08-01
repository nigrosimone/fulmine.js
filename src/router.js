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
    needsConversionToRegex,
    findIndexStartingFrom,
    canBeOptimized,
    NullObject,
    EMPTY_REGEX
} = require("./utils.js");
const Response = require("./response.js");
const Request = require("./request.js");
const { EventEmitter } = require("tseep");
const compileDeclarative = require("./declarative.js");
const statuses = require("statuses");

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
const supportedUwsMethods = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "CONNECT", "TRACE"]);

const regExParam = /:(\w+)/g;

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

        for (const method of methods) {
            this[method] = (path, ...callbacks) => {
                return this.createRoute(method, path, this, ...callbacks);
            };
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
                } else if (!route.complex && canBeOptimized(route.path) && supportedUwsMethods.has(route.method)) {
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
                if (request._error) {
                    return this._handleError(request._error, null, request, response);
                }
                if (request._isOptions && request._matchedMethods.size > 0) {
                    // Express 5 sorts the methods and joins them with ", ", so the header reads the
                    // same regardless of the order the routes happened to be registered in
                    const allowedMethods = Array.from(request._matchedMethods).sort().join(", ");
                    response.setHeader("Allow", allowedMethods);
                    response.send(allowedMethods);
                    return;
                }
                response.status(404);
                request.noEtag = true;
                this._sendErrorPage(request, response, `Cannot ${request.method} ${request._originalPath}`, false);
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
            this._paramCallbacks.size === 0 && // app.param() is not supported
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
        if (!this.get("strict routing") && route.path[route.path.length - 1] !== "/") {
            this.uwsApp[method](replacedPath + "/", fn);
            if (method === "get") {
                this.uwsApp.head(replacedPath + "/", realFn);
            }
        }
        if (method === "get") {
            this.uwsApp.head(replacedPath, realFn);
        }
    }

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
        const obj = { __proto__: null };
        const wildcardNames = pattern._wildcardNames;
        if (match?.groups) {
            for (const name in match.groups) {
                const value = match.groups[name];
                // an optional group that did not match is absent in v5, not present as undefined
                if (value === undefined) {
                    continue;
                }
                obj[name] = wildcardNames?.includes(name) ? value.split("/") : value;
            }
        }
        return obj;
    }

    _preprocessRequest(req, res, route) {
        req.route = route;
        if (route.optimizedParams) {
            req.params = Object.assign({ __proto__: null }, req.optimizedParams);
        } else if (route.complex) {
            let path = req._originalPath;
            if (req._stack.length > 0) {
                const fullMountpath = this.getFullMountpath(req);
                if (fullMountpath !== EMPTY_REGEX) {
                    path = path.replace(fullMountpath, "");
                }
            }
            req.params = this._extractParams(route.pattern, path);
            if (req._paramStack.length > 0) {
                for (const params of req._paramStack) {
                    req.params = Object.assign({ __proto__: null }, params, req.params);
                }
            }
        } else {
            req.params = {};
            if (req._paramStack.length > 0) {
                for (const params of req._paramStack) {
                    req.params = Object.assign({ __proto__: null }, params, req.params);
                }
            }
        }

        if (this._paramCallbacks.size > 0) {
            // known issue, not introduced here: an async executor swallows anything it throws,
            // because the rejection has nowhere to go once the promise is already constructed.
            // app.param() callbacks that throw synchronously are therefore lost. Fixing it means
            // restructuring this into an async function that returns a promise, which changes
            // when the param callbacks run relative to the route, so it needs its own change.
            // eslint-disable-next-line no-async-promise-executor
            return new Promise(async (resolve) => {
                for (const param in req.params) {
                    const pcs = this._paramCallbacks.get(param);
                    if (pcs && !req._gotParams.has(param)) {
                        req._gotParams.add(param);
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
            req.app = this; // restore app in case the optimized path swapped it to a mounted sub-app
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
        if (this._paramCallbacks.size !== 0 || req.routeCount % 300 === 0) {
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

    _runRoute(req, res, routeIndex, route, routes, skipCheck, skipUntil, resolve, reject, continueRoute) {
        let callbackindex = 0;
        const strictRouting = this.get("strict routing");
        if (route.use) {
            if (route.mountApp) {
                // optimized chain: normal dispatch swaps req.app when it enters a mounted Application,
                // but the compiled mount route has no callback to do it, so swap it here
                req.app = route.mountApp;
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
                            req.app = req.app.parent;
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
            if (callback instanceof Router) {
                if (callback.constructor.name === "Application") {
                    req.app = callback;
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

                    // skipping routes we already went through via optimized path
                    if (!skipCheck && skipUntil && skipUntil.routeKey >= route.routeKey) {
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

    _sendErrorPage(request, response, err, checkEnv = false) {
        err = this._generateErrorPage(err, response.statusCode, checkEnv);
        request.noEtag = true;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy", "default-src 'none'");
        response.send(err);
    }
};
