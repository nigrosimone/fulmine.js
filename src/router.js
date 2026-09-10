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
    canBeOptimizedWithParams,
    pathsCanOverlap,
    regexpGroupKeys,
    NullObject,
    EMPTY_REGEX,
    settingsEpoch
} = require("./utils.js");
const Response = require("./response.js");
const Request = require("./request.js");
const { EventEmitter } = require("tseep");
const statuses = require("statuses");
const { METHODS } = require("http");
const { isNodeRequest, serveNodeRequest } = require("./node-shim.js");
const { kGetSafe } = require("./usage.js");
const { checkBehavior } = require("./websocket.js");
const { HotSettings, settingsWriteTraps } = require("./hot-settings.js");
const Walk = require("./walk.js");
const { useRouterClass, optimizeRoute, compileOptimizedRoutes, registerUwsRoute } = require("./optimizer.js");
const {
    layerFor,
    routeLayer,
    nativeDone,
    nativeFail,
    ownParamNames,
    mergesParams,
    EMPTY_INDICES,
    buildLiteralIndex,
    firstAtLeast,
    mergeParams,
    adoptPlainRequest,
    logError,
    onNativeAborted,
    checkHandlers,
    CALLBACK_PLAIN,
    CALLBACK_ERROR,
    CALLBACK_ROUTER,
    raiseDecodeFailure,
    stepsOver,
    useApp,
    methods,
    callablePrototypeFor,
    generateErrorPageHtml
} = require("./router-utils.js");

/** @typedef {import("./router-utils.js").RouteEntry} RouteEntry */
/** @typedef {import("./router-utils.js").SkipHolder} SkipHolder */
/** @typedef {import("./router-utils.js").NativePreset} NativePreset */
/** @typedef {import("./router-utils.js").Layer} Layer */
/** @typedef {import("./router-utils.js").WsRoute} WsRoute */
/** @typedef {import("uWebSockets.js").HttpRequest} UwsRequest */
/** @typedef {import("uWebSockets.js").HttpResponse} UwsResponse */

// hands out one number per app.route(), so the routes it creates know they belong together
let routeGroups = 0;

let routeKey = 0;

module.exports = class Router extends EventEmitter {
    /**
     * The router or application this one is mounted on, undefined until it is.
     * @type {Router|undefined}
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
     * The hot-path settings resolved to fields, good while the epoch stands, see _hot().
     * @type {HotSettings}
     */
    _hotSettings = new HotSettings();

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
        /** @type {WsRoute[]|null} */
        this._wsRoutes = null;
        // the native presets allowed to skip the header copy, so a late middleware or an etag
        // arriving after listen can take the permission back; null until one is granted
        /** @type {Set<SkipHolder>|null} */
        this._skipPresets = null;
        /** @type {boolean|undefined} */
        this._hasErrMwCache = undefined;
        // an array when mounted on several paths at once, as Express allows
        /** @type {string|string[]} */
        this.mountpath = "/";
        // The settings twice: the plain object everything inside here reads, and the Proxy the
        // outside gets. Express lets an application write app.settings["x"] straight, which set()
        // never sees, so the hot copies in _hot() kept answering the old value. The trap bumps the
        // epoch on the spot. Reading through a Proxy costs about 20ns, so the inside never does
        this._settings = settings;
        this.settings = new Proxy(settings, settingsWriteTraps);
        // the base classes; an Application replaces these with its own per-app subclasses, and a
        // plain router has no request/response prototype layer, as in Express
        // Typed loosely because an Application replaces both with per-app subclasses of its own,
        // and a field declared as the base class would not accept one under strictFunctionTypes
        /** @type {any} */
        this._request = Request;
        /** @type {any} */
        this._response = Response;

        if (typeof settings.caseSensitive !== "undefined") {
            settings["case sensitive routing"] = settings.caseSensitive;
            delete settings.caseSensitive;
        }
        if (typeof settings.strict !== "undefined") {
            settings["strict routing"] = settings.strict;
            delete settings.strict;
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
     * @param {any} req a Request, or the plain object express's own router tests drive it with
     * @param {any} res a Response, or whatever the caller is serving with
     * @param {(err?: unknown) => void} [next]
     * @returns {Promise<void>}
     */
    async handle(req, res, next) {
        // a request from node's own server, which is what http.createServer(app) delivers
        if (isNodeRequest(req)) {
            return serveNodeRequest(this, req, res, next);
        }
        // an app taking over a request becomes that request's app, as it does when mounted, so
        // req.app.get("view engine") inside a sub-app reads the sub-app's settings. A plain router
        // is not an app and leaves it alone, as Express's router.handle does.
        // a plain object, which is how express's router can be driven and how its own tests drive it
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
            // the raw object, not the Proxy: see the constructor
            const res = this._settings[key];
            if (typeof res === "undefined" && this.parent) {
                return this.parent.get(key);
            } else {
                return res;
            }
        }
        return this.createRoute("GET", path, this, ...callbacks);
    }

    /**
     * The settings the hot path reads, as fields on one object rather than a get() per read.
     * Refreshed through get(), parent fallback and all, when the epoch says a set() or a mount
     * happened anywhere since they were resolved; until then a read is a monomorphic field load.
     *
     * @returns {HotSettings}
     */
    _hot() {
        const hot = this._hotSettings;
        if (hot.epoch === settingsEpoch.n) {
            return hot;
        }
        hot.xPoweredBy = !!this.get("x-powered-by");
        hot.etagFn = this.get("etag fn");
        // a Set here, an array in the settings: send() asks per response, set() runs once
        const etagMethods = this.get("etag methods");
        hot.etagMethods = etagMethods == null ? null : new Set(etagMethods);
        hot.queryParserFn = this.get("query parser fn");
        hot.trustProxyFn = this.get("trust proxy fn");
        hot.trustProxyProtocol = !!this.get("trust proxy protocol");
        hot.jsonEscape = this.get("json escape");
        hot.jsonReplacer = this.get("json replacer");
        hot.jsonSpaces = this.get("json spaces");
        hot.epoch = settingsEpoch.n;
        return hot;
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
        const own = this._settings[key];
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
     * @param {Request} req
     * @returns {RegExp}
     */
    getFullMountpath(req) {
        // path-less app.use() pushes "", so a stack of only those joins to "" no matter how deep it is.
        // patternToRegex("", true) is EMPTY_REGEX, so this returns exactly what the join path would,
        // The null first: _stack stays null until a mount is entered, and this is reachable from
        // an unmounted request. It used to read a counter that no longer exists, so it threw
        if (req._stack === null || req._stack.length === 0) {
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
     * The generic scan over this router's own table, driven by the literal index: only the routes
     * registered for this exact path, plus every non-literal route, are visited, in registration
     * order, and each one still answers through the same method gate and _pathMatches the plain
     * loop used. The routes skipped are exactly the literals whose string compare provably fails.
     *
     * Runs after _freezeRoutingFlags, which is what makes _caseFlag and _strictFlag readable here.
     *
     * @param {Request} req
     * @param {number} startIndex where to resume the scan
     * @param {boolean} mayFailDecode whether the path carries a percent escape
     * @returns {number} the index of the route to enter, or the table length for none
     */
    _scanFrom(req, startIndex, mayFailDecode) {
        const routes = this._routes;
        const index = (this._literalIndex ??= buildLiteralIndex(routes, /** @type {boolean} */ (this._caseFlag)));
        let path = req._opPath;
        if (path === "") {
            path = "/";
        }
        if (!this._caseFlag) {
            path = req._opPathLower ??= path.toLowerCase();
        }
        const exact = index.map.get(path) ?? EMPTY_INDICES;
        // the trailing-slash twin _pathMatches allows outside strict routing, as a key: a path
        // "/a/" can only text-match a literal "/a", so that list joins the candidates
        const slashed =
            !this._strictFlag && path.charCodeAt(path.length - 1) === 0x2f
                ? (index.map.get(path.slice(0, -1)) ?? EMPTY_INDICES)
                : EMPTY_INDICES;
        const always = index.alwaysVisit;
        let exactAt = firstAtLeast(exact, startIndex);
        let slashedAt = firstAtLeast(slashed, startIndex);
        let alwaysAt = firstAtLeast(always, startIndex);
        const method = req.method;
        const none = routes.length;
        for (;;) {
            // the next candidate in registration order, from whichever list holds it
            let routeIndex = none;
            if (exactAt < exact.length && exact[exactAt] < routeIndex) {
                routeIndex = exact[exactAt];
            }
            if (slashedAt < slashed.length && slashed[slashedAt] < routeIndex) {
                routeIndex = slashed[slashedAt];
            }
            if (alwaysAt < always.length && always[alwaysAt] < routeIndex) {
                routeIndex = always[alwaysAt];
            }
            if (routeIndex === none) {
                return none;
            }
            if (exactAt < exact.length && exact[exactAt] === routeIndex) {
                exactAt++;
            }
            if (slashedAt < slashed.length && slashed[slashedAt] === routeIndex) {
                slashedAt++;
            }
            if (alwaysAt < always.length && always[alwaysAt] === routeIndex) {
                alwaysAt++;
            }
            const r = routes[routeIndex];
            // the same gates as the plain loop, comments and all: see dispatch
            if (!(
                r.all ||
                r.method === method ||
                req._isOptions ||
                (req._isHead && (r.gettable || r.paramCallbacks.size > 0))
            )) {
                if (mayFailDecode && this._pathMatches(r, req) && this._paramsFailToDecode(r, req)) {
                    return routeIndex;
                }
                continue;
            }
            if (this._pathMatches(r, req)) {
                if (r.bodyParserOnly === true && stepsOver(r, req)) {
                    continue;
                }
                return routeIndex;
            }
        }
    }

    /**
     * Whether a route's path matches this request. A plain string compares directly, which is what
     * makes a route eligible for the native router; anything carrying a parameter or a wildcard was
     * turned into a regular expression when it was registered.
     *
     * @param {RouteEntry} route
     * @param {Request} req
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
            // bare fields, frozen by dispatch once per scan: even the freeze's own undefined
            // check measured 0.45us per request on a scan of four hundred routes
            if (!this._caseFlag) {
                // the pattern was folded at registration. The path is folded once per rewrite and
                // kept on the request, not folded again per route: every _opPath write drops it
                pattern = /** @type {string} */ (route.patternLower);
                path = req._opPathLower ??= path.toLowerCase();
            }
            if (pattern === path) {
                return true;
            }
            // a literal path is compared as text rather than compiled, so the trailing slash a
            // pattern would have carried as "/?" is allowed here instead. The registered path has
            // had its own taken off already, unless it is the root
            return (
                !this._strictFlag &&
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
     * The layers Express keeps on a router, in Express's own shape: one per middleware, one per
     * route, and the route's own handlers under `route.stack`. Libraries that list an application's
     * endpoints walk this, and so do tests that reach in for a handler by name, which is how
     * LibreChat pulls one middleware out of its router.
     *
     * A view, rebuilt on every read, not the router's own storage: pushing a layer onto it or
     * splicing one out moves nothing. The layer objects are kept, so identities compare across two
     * reads the way they do in Express.
     *
     * @returns {Layer[]}
     */
    get stack() {
        const layers = [];
        for (const route of this._routes) {
            if (route.use) {
                for (const callback of route.callbacks) {
                    layers.push((route._layers ??= new Map()).get(callback) ?? layerFor(route, callback));
                }
            } else {
                layers.push((route._routeLayer ??= routeLayer(route)));
            }
        }
        return layers;
    }

    /**
     * Registers a route, which every method helper and use() funnel into. Several paths at once
     * become several routes sharing the callbacks, as Express allows. Paths are normalised here and
     * not at match time: no trailing slash unless strict routing, "*" becomes "/{*splat}", and
     * anything not comparable as a string is compiled to a regular expression and marked complex.
     *
     * @param {string} method HTTP method, or USE for a mount
     * @param {string|RegExp|(string|RegExp)[]} path one path or several
     * @param {any} [parent] what to return, so chaining lands on the app rather than the router.
     *   Loose because it is also the builder app.route() hands back
     * @param {...any} callbacks handlers, or arrays of them at any depth, flattened below. Loose
     *   because a parameter keeps its declared type through that reassignment
     * @returns {any} parent
     */
    createRoute(method, path, parent = this, ...callbacks) {
        method = method.toUpperCase();
        callbacks = callbacks.flat(Infinity);
        checkHandlers(callbacks);
        // What express hangs off req.route as its methods, and the three registrations disagree:
        // app.all() registers every verb one at a time, so the map names all of them; router.all()
        // and app.route().all() mark the route _all instead; everything hung off one app.route()
        // shares one map. Built in node's own order, so it reads back key for key as express's does
        let methodMap;
        let stack;
        if (method !== "USE") {
            methodMap = this._pendingGroupMethods ?? new NullObject();
            // and the layers behind them, which is express's Route#stack: one per handler per verb
            // the route was registered for, in the order express pushes them. app.all() therefore
            // has one for every verb, since that is how many times express registers the handler
            stack = this._pendingGroupStack ?? [];
            let verbs;
            if (method === "ALL") {
                if (this._isApplication && this._pendingGroup === undefined) {
                    verbs = [];
                    for (const known of METHODS) {
                        const lowered = known.toLowerCase();
                        methodMap[lowered] = true;
                        verbs.push(lowered);
                    }
                } else {
                    methodMap._all = true;
                    // Route#all leaves the layer without one, and express reads that as any verb
                    verbs = [undefined];
                }
            } else {
                methodMap[method.toLowerCase()] = true;
                verbs = [method.toLowerCase()];
            }
            for (const verb of verbs) {
                for (const handle of callbacks) {
                    stack.push({
                        handle,
                        name: handle.name || "<anonymous>",
                        params: undefined,
                        path: undefined,
                        keys: [],
                        method: verb
                    });
                }
            }
        }
        // Several paths at once are one route to express, whose path is the array it was given,
        // and several here, one per path, so they share the map and the stack and read back with
        // the array as their path.
        const writtenPath = path;
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
            const pattern =
                method === "USE" || needsConversionToRegex(path)
                    ? patternToRegex(path, method === "USE", this._caseSensitive(), this._strictRouting())
                    : path;
            const route = {
                method: method === "USE" ? "ALL" : method,
                path,
                pattern,
                // folded here once: _pathMatches compares insensitively per route per hop, and
                // the registered text never changes. null for a compiled pattern
                patternLower: typeof pattern === "string" ? pattern.toLowerCase() : null,
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
                // a literal mount consumes exactly its registered text, so what the per-hop exec
                // in mountPrefixLength answers is a constant. "/" stays with the exec: its clamp
                // against a parent that consumed everything is not a constant
                mountLen:
                    method === "USE" && typeof path === "string" && path.length > 1 && !/[:*{\\]/.test(path)
                        ? path.length
                        : undefined,
                // a mount written as a RegExp matches a piece of path that is not known until a
                // request comes in, so its stack entry cannot be the path itself
                regexMount: method === "USE" && path instanceof RegExp,
                // written by the application, so express matches it as it stands
                userRegexp: path instanceof RegExp,
                // express reads these off req.route, and a middleware has none: see _preprocessRequest
                methods: methodMap,
                stack,
                // the route as a request sees it, which is the route itself unless the path was
                // normalised. Written into the literal so every route keeps one shape
                exposed: /** @type {RouteEntry|undefined} */ (undefined),
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
            // Everything here matches on the normalised path, and express hands out the written
            // one: a route registered as "/users/" is matched as "/users" with strict routing off
            // and still reads back with its slash. Rather than carry two paths through the
            // optimizer, a route whose path was normalised gets a view of itself with the written
            // path on top, and that is the one the request is given.
            route.exposed = route;
            if (writtenPath !== path) {
                const view = Object.create(route);
                view.path = writtenPath;
                route.exposed = view;
            }
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
        // the literal index positions are stale the moment the table grows
        this._literalIndex = undefined;

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
     * The chain a request would walk to reach this route, see optimizeRoute in optimizer.js. Kept
     * as a method because a mounted router is asked for its own through it.
     *
     * @param {RouteEntry} route
     * @param {RouteEntry[]} routes every route of this router, in registration order
     * @returns {RouteEntry[]|false} the chain, ending in the route itself
     */
    _optimizeRoute(route, routes) {
        return optimizeRoute(this, route, routes);
    }

    /**
     * Hands every route reachable by path alone to the native uWS router, see
     * compileOptimizedRoutes in optimizer.js. Runs once, when the app starts listening.
     */
    _compileOptimizedRoutes() {
        compileOptimizedRoutes(this);
    }

    /**
     * Wraps a uWS request and response in ours and links them, which is the first thing every
     * request does whichever path serves it. The response rides back as request.res: returning
     * a `{ request, response }` pair was one throwaway object per request.
     *
     * @param {UwsResponse} res uWS response
     * @param {UwsRequest} req uWS request, readable only during this call
     * @param {NativePreset} [preset] a literal registration's constants, see nativePreset
     * @param {SkipHolder} [skipHolder] the object a granted header skip lives on: the preset itself
     *   for a literal registration, a holder of its own for a parameterised one
     * @returns {Request} the request, with the response reachable as request.res
     */
    handleRequest(res, req, preset, skipHolder) {
        const request = new this._request(req, res, this, preset, skipHolder);
        const response = new this._response(res, request, this);
        request.res = response;

        return request;
    }

    /**
     * Refuses a request whose framing cannot be trusted and hangs up without answering. No route
     * runs, so nothing downstream can be reached by one.
     *
     * Hanging up is the point: uWS has already read what followed the body it believed in as a
     * second, pipelined request, and it dispatches that one unless the socket goes. Node answers
     * 400 and then closes, and this cannot do both: uWS only skips the queued request when the
     * response is closed rather than completed, and writeStatus, end and endWithoutBody all
     * complete it. Every combination was measured and delivering the 400 always let the smuggled
     * request through, so the close wins.
     *
     * Called once handleRequest has fully returned, never from inside it: an Application links the
     * response into its pending list after the base call, and the 'close' emitted here takes it out.
     *
     * @param {Response} response
     */
    _refuseRequest(response) {
        response.finished = true;
        response._res.close();
        response.emit("close");
    }

    /**
     * Tells uWS whom to call on a client abort. Out of handleRequest, because uWS only needs it
     * for a response that outlives its handler callback: the native handler arms it in its
     * finally when the answer is still pending, which on a synchronous route it never is.
     *
     * @param {UwsResponse} res uWS response
     * @param {Response} response
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
     * @param {RouteEntry} route
     * @param {RouteEntry[]} routes every route of the router this one belongs to
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
     * Registers one route with uWS, see registerUwsRoute in optimizer.js. Kept as a method because
     * the optimizer tests replace it to see which routes went native.
     *
     * @param {RouteEntry} route
     * @param {RouteEntry[]} optimizedPath the chain the route was optimized with
     */
    _registerUwsRoute(route, optimizedPath) {
        registerUwsRoute(this, route, optimizedPath);
    }

    /**
     * Gives an error to the handler that asked for it, or answers with it when there is none.
     * Passing something to next() from an error handler clears the error and resumes routing,
     * which is how Express lets a handler decide the error was not fatal.
     *
     * @param {any} err whatever was thrown, which need not be an Error
     * @param {Function|null} handler the four-argument handler to call, or null for the default
     * @param {Request} request
     * @param {Response} response
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
        logError(this, err);
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
     * @param {unknown} err whatever was thrown, which need not be an Error
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
     * @param {Request} req
     * @param {Response} res
     * @param {RouteEntry} route
     * @returns {Promise<true|"route">|true|"route"} a promise only when a param callback is involved
     */
    _preprocessRequest(req, res, route) {
        // express sets this inside Route#dispatch, so only a route ever writes one: a middleware
        // reads undefined there, and so does a request nothing routed. Code that tells a route
        // from a middleware by asking for req.route, which is how a metric gets its name, read
        // the mount here and named itself after it
        if (route.use !== true) {
            req.route = route.exposed;
        }
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
            // the stack check first: it is two field loads, mergesParams is a call, and almost
            // no request carries a param stack at all
            if (req._paramStack !== null && req._paramStack.length > 0 && mergesParams(route, this)) {
                req.params = mergeParams(req.params, req._paramStack);
            }
        } else {
            // express 5 gives every matched route null-prototype params; only a pathless
            // middleware layer keeps the plain object, as its router hands one to fast_slash
            req.params = route.use && route.path === "" ? {} : Object.create(null);
            if (req._paramStack !== null && req._paramStack.length > 0 && mergesParams(route, this)) {
                req.params = mergeParams(req.params, req._paramStack);
            }
        }

        // the route's own router's callbacks: an optimized chain is walked by the app even when it
        // ends in a mounted router's route
        //
        // A route an OPTIONS request reaches only to have its verb counted is not a route this
        // request runs, and express does not run its app.param() callbacks for it. Same condition
        // as the OPTIONS branch in runRoute. The decoding above happens either way, because express
        // decodes a layer whose path matched whatever its method is
        const paramCallbacks = route.paramCallbacks;
        if (paramCallbacks.size > 0 && !(req._isOptions && !route.all && route.method !== "OPTIONS")) {
            return this._runParamCallbacks(req, res, route, paramCallbacks);
        }
        return true;
    }

    /**
     * Whether this route's parameters carry a percent escape that will not decode. Asked only of a
     * route whose path matched and whose method did not, which express still decodes: the 400 it
     * answers there is what this reproduces.
     *
     * @param {RouteEntry} route
     * @param {Request} req
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
     * Express calls one once per value and not once per request: the same name with a different
     * value calls it again, and a value already seen restores what that call left in req.params,
     * its deferral or its error included, without running anything.
     *
     * @param {Request} req
     * @param {Response} res
     * @param {RouteEntry} route
     * @param {Map<string, Function[]>} paramCallbacks the owning router's, which is also the key of
     *   its own cache: two routers that declare the same parameter each call their own
     * @returns {Promise<true|"route">|true}
     */
    _runParamCallbacks(req, res, route, paramCallbacks) {
        // the names this route captured itself, not everything in req.params: a merged-in name
        // belongs to the mount that captured it, see ownParamNames
        let names;
        const own = ownParamNames(route);
        for (let i = 0; i < own.length; i++) {
            const name = own[i];
            // an optional group that did not match leaves no parameter to call anything for
            if (paramCallbacks.has(name) && req.params[name] !== undefined) {
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
     * @returns {Promise<RouteEntry|false>}
     */
    _routeRequest(req, res, startIndex = 0, routes = this._routes, skipCheck = false, skipUntil) {
        return new Promise((resolve, reject) => {
            new Walk(this, req, res, routes, skipCheck, skipUntil, resolve, reject).dispatch(startIndex);
        });
    }

    /**
     * The same walk without the promise pair, for a uWS handler that never awaited it. nativeDone
     * and nativeFail defer their epilogues to the microtask the await used to resume on, so the
     * visible order holds.
     *
     * @param {Request} req
     * @param {Response} res
     */
    _routeRequestDirect(req, res) {
        const walk = new Walk(this, req, res, this._routes, false, undefined, nativeDone, nativeFail);
        try {
            walk.dispatch(0);
        } catch (err) {
            // what a throw inside a promise executor did: reject, once
            nativeFail.call(walk, err);
        }
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
                // what the child resolves through its parent just changed, so every kept
                // resolution is stale
                settingsEpoch.n++;
            }
        }
        // a handler in the path position was moved to the callbacks above
        this.createRoute("USE", /** @type {string|RegExp|(string|RegExp)[]} */ (path), this, ...callbacks);
        return this;
    }

    /**
     * Registers a websocket route, which uWS serves itself.
     *
     * The behavior is uWS's, settings and socket handlers alike, plus one addition: an
     * `upgrade(req, res)` of this project's own shape, which runs before the handshake with a real
     * request and response. Answering with the response declines the socket; returning a promise
     * holds the handshake until it settles.
     *
     * The request lives as long as the socket and reaches every handler as `ws.req`.
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
     * @param {Record<string, unknown>} behavior uWS's WebSocketBehavior, plus the optional `upgrade` above
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
        // one map for the whole chain, because express builds one Route for it: a request answered
        // by the get() of an app.route() reads post() in its req.route.methods too
        const groupMethods = new NullObject();
        const groupStack = [];
        // express hands back a Route, which carries these three beside the verb methods
        fns.path = path;
        fns.methods = groupMethods;
        fns.stack = groupStack;
        const inGroup = (method, callbacks) => {
            this._pendingGroup = group;
            this._pendingGroupMethods = groupMethods;
            this._pendingGroupStack = groupStack;
            try {
                return this.createRoute(method, path, fns, ...callbacks);
            } finally {
                this._pendingGroup = undefined;
                this._pendingGroupMethods = undefined;
                this._pendingGroupStack = undefined;
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
     * @param {Request} request
     * @param {Response} response
     * @param {unknown} err whatever was thrown, which need not be an Error
     * @param {boolean} [checkEnv] whether production should redact it
     */
    _sendErrorPage(request, response, err, checkEnv = false) {
        err = this._generateErrorPage(err, response.statusCode, checkEnv);
        request.noEtag = true;
        // a header that cannot be written is what brought the request here in the first place when
        // the throw came out of the flush, and writing it again would throw with nobody left
        response._dropUnwritableHeaders();
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
     * @param {Request} request
     * @param {Response} response
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
     * @param {Request} request
     * @param {Response} response
     */
    _endUnmatched(request, response) {
        if (request._error) {
            return this._handleError(request._error, null, request, response);
        }
        // the null test costs nothing outside an OPTIONS request, and only one carries the set
        if (request._isOptions && request._matchedMethods !== null && request._matchedMethods.size > 0) {
            try {
                this._sendOptionsReply(request, response, request._matchedMethods);
            } catch (err) {
                // a head already written: the error answers instead, as express's does
                this._handleError(err, null, request, response);
            }
            return;
        }
        response.status(404);
        // the pathname of originalUrl, as express's finalhandler prints it: _originalPath absorbs
        // a req.url rewrite, originalUrl never changes
        const originalUrl = String(request.originalUrl);
        const queryIndex = originalUrl.indexOf("?");
        const pathname = queryIndex === -1 ? originalUrl : originalUrl.slice(0, queryIndex);
        this._sendErrorPage(request, response, `Cannot ${request.method} ${pathname}`, false);
    }
};

// The verb methods go on the prototype, not on each instance. As own arrows they closed over the
// instance they were built on, so express.Router().post(...) answered with the object the callable
// was copied from. One closure per name for the process instead of one per router, too.
// the optimizer needs the class to tell a mounted router from a plain handler
useRouterClass(module.exports);

for (const method of methods) {
    module.exports.prototype[method] = function (path, ...callbacks) {
        return this.createRoute(method, path, this, ...callbacks);
    };
}
