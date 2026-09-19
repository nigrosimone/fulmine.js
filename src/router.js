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
    headersSentError,
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

// one number per app.route(), so the routes it creates know they belong together
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
     * The uWS app routes are registered on, which only an Application owns.
     *
     * @returns {any}
     */
    get uwsApp() {
        return undefined;
    }

    /**
     * Whether an unset routing flag reads on through the mount parent: an application's settings
     * chain onto its parent's in express, a plain Router's do not.
     *
     * @type {boolean}
     */
    _inheritsSettings = false;

    /**
     * A field rather than a name comparison, read on the dispatch path.
     *
     * @type {boolean}
     */
    _isApplication = false;

    /**
     * Whether something served from here read req.ip after the response, once µWS freed the
     * address. Set from Request#parsedIp. Here and not on Application: a plain Router serves
     * requests through the node shim.
     *
     * @type {boolean}
     */
    needsIpAfterResponse = false;

    /**
     * How many requests read the peer address up front so one of them can find out, a hundred
     * and no more (a wrapping counter reopened the window).
     *
     * @type {number}
     */
    _ipProbes = 0;

    /**
     * The routing flags, frozen at the first read as express passes them to its router once.
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

    /** app.param() callbacks by parameter name. @type {Map<string, Function[]>} */
    _paramCallbacks = new Map();

    /** The pattern of what the mounts consumed, by the joined stack, see getFullMountpath. @type {Map<string, RegExp>} */
    _mountpathCache = new Map();

    /** @type {RouteEntry[]} */
    _routes = [];

    /** Websocket routes, µWS serves them itself and listen() hands them over whole. @type {WsRoute[]|null} */
    _wsRoutes = null;

    /**
     * The native presets allowed to skip the header copy, so a route added after listen can take
     * the permission back.
     * @type {Set<SkipHolder>|null}
     */
    _skipPresets = null;

    /** Whether the table holds error middleware, undefined until the optimizer asks. @type {boolean|undefined} */
    _hasErrMwCache;

    /** An array when mounted on several paths at once. @type {string|string[]} */
    mountpath = "/";

    /**
     * The settings: the plain object for the inside, the Proxy for the outside, where a write to
     * app.settings["x"] bumps the epoch so _hot() refreshes. A Proxy read costs about 20ns.
     * @type {Record<string, any>}
     */
    _settings;

    /** @type {Record<string, any>} */
    settings;

    /** An Application replaces both with per-app subclasses, loose for strictFunctionTypes. @type {any} */
    _request = Request;

    /** @type {any} */
    _response = Response;

    /**
     * The generic scan's index over the literal patterns, built on the first scan and dropped by
     * a registration, see _scanFrom.
     * @type {ReturnType<typeof buildLiteralIndex>|undefined}
     */
    _literalIndex;

    /**
     * The app.route() chain being registered, so its routes share one error group, one method
     * map and one stack as express's Route has, see createRoute.
     * @type {number|undefined}
     */
    _pendingGroup;

    /** @type {Record<string, any>|undefined} */
    _pendingGroupMethods;

    /** @type {(Omit<Layer, "route"> & {method: string|undefined})[]|undefined} */
    _pendingGroupStack;

    /**
     * @param {Record<string, any>} [settings] router options. caseSensitive and strict are accepted under the
     *   names Express's Router takes, and stored under the setting names the rest of the code reads
     */
    constructor(settings = {}) {
        super();
        this._settings = settings;
        this.settings = new Proxy(settings, settingsWriteTraps);

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
     * This router as the function express.Router() hands back: the router's own properties, same
     * objects, with the router's prototype behind it.
     *
     * @returns {any} the callable
     */
    _asCallable() {
        const fn = /** @type {any} */ (
            function (req, res, next) {
                return fn.handle(req, res, next);
            }
        );
        // defineProperties, not Object.assign: past a dozen keyed stores V8 puts a function in
        // dictionary mode, and every field read on the request path was a hash lookup
        Object.defineProperties(fn, Object.getOwnPropertyDescriptors(this));
        Object.setPrototypeOf(fn, callablePrototypeFor(Object.getPrototypeOf(this)));
        return fn;
    }

    /**
     * Express's app.handle and router.handle: next() when nothing answered.
     *
     * @param {any} req a Request, or the plain object express's own router tests drive it with
     * @param {any} res a Response, or whatever the caller is serving with
     * @param {(err?: unknown) => void} [next]
     * @returns {Promise<void>}
     */
    async handle(req, res, next) {
        // from http.createServer(app)
        if (isNodeRequest(req)) {
            return serveNodeRequest(this, req, res, next);
        }
        // a plain object, as express's own router tests drive it
        if (req._opPath === undefined) {
            if (typeof req.url !== "string" || req.url === "") {
                // parseurl answers nothing for these and express hands the request straight back
                return next ? next() : undefined;
            }
            adoptPlainRequest(req, this);
        }
        // an app taking over a request becomes its req.app, as when mounted; a plain router does not
        if (this.constructor.name === "Application") {
            useApp(req, this);
        }
        // express restores req.params when a router hands back
        const callerParams = req.params;
        const routed = await this._routeRequest(req, res, 0);
        if (!routed) {
            req.params = callerParams;
            if (next) {
                // an error nobody handled belongs to the caller
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
     * Two methods sharing a name, as in Express: a setting with no handlers, parent fallback
     * included, or a GET route, which also answers HEAD.
     *
     * @param {string} path setting name, or route path
     * @param {...(Function|Array<Function>)} callbacks handlers; none means read a setting
     * @returns {*} the setting value, or the created route
     */
    get(path, ...callbacks) {
        if (typeof path === "string" && callbacks.length === 0) {
            const key = path;
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
     * The settings the hot path reads, as fields refreshed when the epoch says a set() or a mount
     * happened since.
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
     * A routing flag as express resolves it once, when it builds the router's matcher: a later
     * mount or app.set() cannot change how this router matches.
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

    /** Both flags at once, as express passes them together: frozen apart they could disagree. */
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
     * The pattern matching what the mounts on this request consumed so far, cached per stack.
     *
     * @param {Request} req
     * @returns {RegExp}
     */
    getFullMountpath(req) {
        // null until a mount is entered; pathless mounts push "", which joins to EMPTY_REGEX
        if (req._stack === null || req._stack.length === 0) {
            return EMPTY_REGEX;
        }
        const fullStack = req._stack.join("");
        let fullMountpath = this._mountpathCache.get(fullStack);
        if (!fullMountpath) {
            // a RegExp mount keys this by what it matched, per request
            if (this._mountpathCache.size > 1024) {
                this._mountpathCache.clear();
            }
            // two mounts may reuse a name, which a named-group compile refuses: renamed by
            // position, nothing reads them. An escaped colon is a literal one
            const stackPattern = fullStack.includes(":")
                ? fullStack.replace(/(\\?):(\w+)/g, (whole, escaped, name, at) => (escaped ? whole : ":m" + at))
                : fullStack;
            // insensitive whatever this router says: the prefix was already accepted by the routers
            // owning those mounts, and a sensitive router under an insensitive app is reached as /LIST
            fullMountpath = patternToRegex(stackPattern, true, false);
            this._mountpathCache.set(fullStack, fullMountpath);
        }
        return fullMountpath;
    }

    /**
     * The generic scan over this router's table through the literal index: the routes registered
     * for this exact path plus every non-literal one, in registration order, through the same
     * gates as the plain loop. Runs after _freezeRoutingFlags.
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
        // the trailing-slash twin outside strict routing: "/a/" text-matches a literal "/a"
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
            // the same gates as the plain loop, see dispatch
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
     * Whether a route's path matches this request: a plain string compares directly, a parameter
     * or wildcard was compiled at registration.
     *
     * @param {RouteEntry} route
     * @param {Request} req
     * @returns {boolean}
     */
    _pathMatches(route, req) {
        let path = req._opPath;
        let pattern = route.pattern;
        // the root reads "" after the mounts, which no pattern is written against
        if (path === "") {
            path = "/";
        }

        if (typeof pattern === "string") {
            if (pattern === "/*") {
                return true;
            }
            // bare fields, frozen by dispatch: the freeze's undefined check alone measured 0.45us
            // per request over four hundred routes
            if (!this._caseFlag) {
                // both folded once, the pattern at registration and the path per rewrite
                pattern = /** @type {string} */ (route.patternLower);
                path = req._opPathLower ??= path.toLowerCase();
            }
            if (pattern === path) {
                return true;
            }
            // the "/?" a compiled pattern would carry, allowed here on the text
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
            // a mount consumes what it matched, so the match must start the path and end on a
            // separator, as express refuses /api/ mounted under /test/api/1234
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
     * The layers in Express's own shape, one per middleware and per route with the handlers under
     * `route.stack`: endpoint listers walk it, LibreChat pulls a middleware out of it by name. A
     * view rebuilt on every read, so pushing or splicing moves nothing; the layer objects are kept,
     * so identities compare across reads.
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
     * Registers a route, what every method helper and use() funnel into. Paths are normalised here:
     * no trailing slash unless strict routing, "*" becomes "/{*splat}", anything not comparable as
     * a string is compiled to a regex and marked complex.
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
        // req.route.methods as express builds it: app.all() names every verb, router.all() and
        // app.route().all() mark _all, an app.route() shares one map
        let methodMap;
        let stack;
        if (method !== "USE") {
            methodMap = this._pendingGroupMethods ?? new NullObject();
            // express's Route#stack, one layer per handler per verb
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
                    // Route#all leaves the layer without a verb
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
        // several paths are one route to express and several here, sharing the map and the stack
        const writtenPath = path;
        const paths = Array.isArray(path) ? path : [path];
        const routes = [];
        for (let path of paths) {
            // a mount always drops it: express registers its use layers with strict off
            if (
                (method === "USE" || !this._strictRouting()) &&
                typeof path === "string" &&
                path.endsWith("/") &&
                path !== "/"
            ) {
                // every one, as express's /\/+$/: "/test//" answers "/test" and "/test/"
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
                // folded once, null for a compiled pattern
                patternLower: typeof pattern === "string" ? pattern.toLowerCase() : null,
                callbacks,
                // instanceof and length ran for every callback of every hop
                callbackKinds: callbacks.map((callback) =>
                    callback instanceof Router
                        ? CALLBACK_ROUTER
                        : callback.length === 4
                          ? CALLBACK_ERROR
                          : CALLBACK_PLAIN
                ),
                // a body parser alone, marked kGetSafe: a hop costs ten times its prologue, see stepsOver
                bodyParserOnly: method === "USE" && callbacks.length === 1 && callbacks[0][kGetSafe] === true,
                // the "body methods" setting as it stood when this layer was first reached
                bodyMethods: undefined,
                // a literal mount consumes exactly its text, so mountPrefixLength's exec is a
                // constant; "/" stays with the exec, its clamp is not
                mountLen:
                    method === "USE" && typeof path === "string" && path.length > 1 && !/[:*{\\]/.test(path)
                        ? path.length
                        : undefined,
                // a RegExp mount matches a piece of path known only per request
                regexMount: method === "USE" && path instanceof RegExp,
                userRegexp: path instanceof RegExp,
                methods: methodMap,
                stack,
                // the route as a request sees it, a view with the written path when normalised
                exposed: /** @type {RouteEntry|undefined} */ (undefined),
                routeKey: routeKey++,
                // which app.route() this came from, one route where an error is concerned
                group: this._pendingGroup,
                // an optimized chain is walked by the app, and param() callbacks belong to the
                // router that declared them
                owner: this,
                // by reference, param() only writes into the map: through owner it measured 8us
                // per thousand requests
                paramCallbacks: this._paramCallbacks,
                use: method === "USE",
                all: method === "ALL" || method === "USE",
                gettable: method === "GET" || method === "HEAD"
            };
            // matched on the normalised path, read back with the written one as express does:
            // "/users/" is matched as "/users" and still reads back with its slash
            route.exposed = route;
            if (writtenPath !== path) {
                const view = Object.create(route);
                view.path = writtenPath;
                route.exposed = view;
            }
            if (
                route.pattern instanceof RegExp &&
                (path instanceof RegExp ||
                    (typeof route.path === "string" &&
                        (route.path.includes(":") || route.path.includes("*") || route.path.includes("{"))))
            ) {
                route.complex = true;
            }
            routes.push(route);
        }
        this._routes.push(...routes);
        this._literalIndex = undefined;

        // a route registered after listen could catch a throw or read a header the analysis
        // proved nothing did, so every skip is taken back
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
     * The chain a request walks to reach this route, see optimizeRoute in optimizer.js.
     *
     * @param {RouteEntry} route
     * @param {RouteEntry[]} routes every route of this router, in registration order
     * @returns {RouteEntry[]|false} the chain, ending in the route itself
     */
    _optimizeRoute(route, routes) {
        return optimizeRoute(this, route, routes);
    }

    /** See compileOptimizedRoutes in optimizer.js. Runs once, at listen. */
    _compileOptimizedRoutes() {
        compileOptimizedRoutes(this);
    }

    /**
     * Wraps a uWS request and response in ours and links them; the response rides back as
     * request.res, a pair was an object per request.
     *
     * @param {UwsResponse} res uWS response
     * @param {UwsRequest} req uWS request, readable only during this call
     * @param {NativePreset} [preset] a literal registration's constants, see nativePreset
     * @param {SkipHolder} [skipHolder] where a granted header skip lives
     * @returns {Request} the request, with the response as request.res
     */
    handleRequest(res, req, preset, skipHolder) {
        const request = new this._request(req, res, this, preset, skipHolder);
        const response = new this._response(res, request, this);
        request.res = response;

        return request;
    }

    /**
     * Refuses a request whose framing cannot be trusted by hanging up without an answer: uWS has
     * already read what followed as a pipelined request and dispatches it unless the socket goes,
     * and any way of delivering node's 400 completes the response and lets it through. Called once
     * handleRequest has returned, so the 'close' here finds the response in the pending list.
     *
     * @param {Response} response
     */
    _refuseRequest(response) {
        response.finished = true;
        response._res.close();
        response.emit("close");
    }

    /**
     * Tells uWS whom to call on a client abort, only for a response that outlives its handler
     * callback: a synchronous route never needs it.
     *
     * @param {UwsResponse} res uWS response
     * @param {Response} response
     */
    _armAbort(res, response) {
        res.onAborted(onNativeAborted.bind(response));
    }

    /**
     * Whether a later route in the same router could match a path this one matches: inside a
     * mount a native chain that runs out resumes after the mount, so a later sibling would be lost.
     * A mount or an unknown pattern counts as an overlap.
     *
     * @param {RouteEntry} route
     * @param {RouteEntry[]} routes every route of the router this one belongs to
     * @returns {boolean}
     */
    _isFollowedByAnOverlap(route, routes) {
        const caseSensitive = this._caseSensitive();
        const routePath = caseSensitive ? route.path : route.path.toLowerCase();
        for (let i = routes.length - 1; i >= 0; i--) {
            const later = routes[i];
            if (later.routeKey <= route.routeKey) {
                return false;
            }
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
     * See registerUwsRoute in optimizer.js. A method, the optimizer tests replace it.
     *
     * @param {RouteEntry} route
     * @param {RouteEntry[]} optimizedPath the chain the route was optimized with
     */
    _registerUwsRoute(route, optimizedPath) {
        registerUwsRoute(this, route, optimizedPath);
    }

    /**
     * Gives an error to the handler that asked for it, or answers with it. next() from an error
     * handler clears the error and resumes routing, as in Express.
     *
     * @param {any} err whatever was thrown, which need not be an Error
     * @param {Function|null} handler the four-argument handler to call, or null for the default
     * @param {Request} request
     * @param {Response} response
     */
    _handleError(err, handler, request, response) {
        if (handler) {
            /** @param {unknown} [pass] */
            const next = (pass) => {
                delete request._error;
                delete request._errorKey;
                return request.next(pass);
            };
            try {
                return handler(err, request, response, next);
            } catch (thrown) {
                request._error = thrown;
                return request.next(thrown);
            }
        }
        logError(this, err);
        // no error page can follow a head that is out: express's final handler closes the connection
        if (response.headersSent) {
            if (!response.finished) {
                response.destroy();
            }
            return;
        }
        // as express's final handler: the error's own status, else the response's, else 500
        const own = [err?.status, err?.statusCode].find((s) => typeof s === "number" && s >= 400 && s < 600);
        let carried;
        if (own !== undefined) {
            response.statusCode = own;
            // the error's headers go out only with a status of its own: a 416 carries its Content-Range
            if (err.headers && typeof err.headers === "object") {
                carried = err.headers;
            }
        } else if (!(response.statusCode >= 400 && response.statusCode <= 599)) {
            response.statusCode = 500;
        }
        this._sendErrorPage(request, response, err, true, carried);
    }

    /**
     * The HTML for an error; in production only what the status means.
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
            // non-strict routing; retried rather than stripped up front, so a wildcard captures
            // "/a/b/" with its last empty segment as Express reports it
            match = pattern.exec(path.slice(0, -1));
        }
        // Object.create(null): the { __proto__: null } literal is 9ns more
        const obj = Object.create(null);
        if (!match) {
            return obj;
        }

        const meta = getPatternMeta(pattern);
        if (meta === undefined) {
            // an application's own RegExp: every capture group lands in params, by name or position
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

        // by name, the groups object is a dictionary and slow to enumerate
        const { paramNames, outputNames, isWildcard } = meta;
        for (let i = 0, len = paramNames.length; i < len; i++) {
            const name = outputNames[i];
            const value = groups[paramNames[i]];
            // an optional group that did not match is absent in v5
            if (value === undefined) {
                continue;
            }
            // a wildcard is an array of segments in v5, each decoded alone so an encoded slash stays inside
            obj[name] = isWildcard[i] ? value.split("/").map(decodeParam) : decodeParam(value);
        }
        return obj;
    }

    /**
     * What a route needs before its handlers run: req.route, req.params (mergeParams included) and
     * the app.param callbacks not already run for this request.
     *
     * @param {Request} req
     * @param {Response} res
     * @param {RouteEntry} route
     * @returns {Promise<true|"route">|true|"route"} a promise only when a param callback is involved
     */
    _preprocessRequest(req, res, route) {
        // only a route writes it, as express does in Route#dispatch: a metric naming itself after
        // req.route read the mount here
        if (route.use !== true) {
            req.route = route.exposed;
        }
        // both: the route flag says it was registered natively, the values that this request came that way
        if (route.optimizedParams && req.optimizedParams) {
            req.params = Object.create(null);
            try {
                for (const name in req.optimizedParams) {
                    req.params[name] = decodeParam(req.optimizedParams[name]);
                }
            } catch (err) {
                raiseDecodeFailure(req, route, err);
                return "route";
            }
        } else if (route.complex) {
            const path = req._opPath;
            try {
                req.params = this._extractParams(route.pattern, path);
            } catch (err) {
                // a parameter that will not decode: express skips the route and answers 400
                raiseDecodeFailure(req, route, err);
                return "route";
            }
            // the stack check first, almost no request carries one
            if (req._paramStack !== null && req._paramStack.length > 0 && mergesParams(route, this)) {
                req.params = mergeParams(req.params, req._paramStack);
            }
        } else {
            // null-prototype params as express 5, except a pathless middleware layer (fast_slash)
            req.params = route.use && route.path === "" ? {} : Object.create(null);
            if (req._paramStack !== null && req._paramStack.length > 0 && mergesParams(route, this)) {
                req.params = mergeParams(req.params, req._paramStack);
            }
        }

        // the route's own router's callbacks: an optimized chain is walked by the app even when it
        // ends in a mounted router's route. Not for a route OPTIONS reaches only to count its verb,
        // express runs no app.param() there, though it still decodes the layer
        const paramCallbacks = route.paramCallbacks;
        if (paramCallbacks.size > 0 && !(req._isOptions && !route.all && route.method !== "OPTIONS")) {
            return this._runParamCallbacks(req, res, route, paramCallbacks);
        }
        return true;
    }

    /**
     * Whether this route's parameters will not decode, asked of a route whose path matched and
     * method did not: express still decodes it and answers 400.
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
     * route may run. Once per value, as in express: a value already seen restores what that call
     * left in req.params, deferral or error included, without running again.
     *
     * @param {Request} req
     * @param {Response} res
     * @param {RouteEntry} route
     * @param {Map<string, Function[]>} paramCallbacks the owning router's, which is also the key of
     *   its own cache: two routers that declare the same parameter each call their own
     * @returns {Promise<true|"route">|true}
     */
    _runParamCallbacks(req, res, route, paramCallbacks) {
        // the names this route captured itself, see ownParamNames
        let names;
        const own = ownParamNames(route);
        for (let i = 0; i < own.length; i++) {
            const name = own[i];
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
            /** @type {unknown} */
            let value;
            let entry;
            /** @type {Function[]} */
            let fns = [];
            let fnIndex = 0;

            // one parameter after the other, err being what the last one's callbacks ended with
            /** @param {unknown} [err] */
            const nextParam = (err) => {
                if (err) {
                    // an error already in flight stays, as express's next(layerError || err)
                    if (err !== "route" && !req._error) {
                        req._error = err;
                        req._errorKey = route.routeKey;
                        req._errorGroup = route.group;
                    }
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
            /** @param {unknown} [err] */
            const nextCallback = (err) => {
                const fn = fns[fnIndex++];
                // a callback rewriting req.params[name] hands that value to every later route
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
        // the router package's messages
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
            let callbacks = this._paramCallbacks.get(key);
            if (callbacks === undefined) {
                this._paramCallbacks.set(key, (callbacks = []));
            }
            callbacks.push(fn);
        }
        return this;
    }

    /**
     * Resolves with the route that answered, or false when nothing matched.
     *
     * @param {Request} req
     * @param {Response} res
     * @param {number} [startIndex]
     * @param {RouteEntry[]} [routes]
     * @param {boolean} [skipCheck] take the route at the index without matching it, see Walk
     * @param {RouteEntry} [skipUntil] route to resume after when this chain runs out, see Walk
     * @returns {Promise<RouteEntry|false>}
     */
    _routeRequest(req, res, startIndex = 0, routes = this._routes, skipCheck = false, skipUntil) {
        return new Promise((resolve, reject) => {
            new Walk(this, req, res, routes, skipCheck, skipUntil, resolve, reject).dispatch(startIndex);
        });
    }

    /**
     * The same walk without the promise pair, for the uWS handler: nativeDone and nativeFail
     * defer their epilogues to a microtask, so the visible order holds.
     *
     * @param {Request} req
     * @param {Response} res
     */
    _routeRequestDirect(req, res) {
        const walk = new Walk(this, req, res, this._routes, false, undefined, nativeDone, nativeFail);
        try {
            walk.dispatch(0);
        } catch (err) {
            nativeFail.call(walk, err);
        }
    }

    /**
     * Mounts middleware or a router at an optional path; a mount matches everything under it.
     * Mounting a Router sets its mountpath and parent and emits 'mount'.
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
                // a pathless or root mount reads "/", as express shows it
                callback.mountpath = /** @type {string|string[]} */ (path === "" ? "/" : path);
                callback.parent = this;
                callback.emit("mount", this);
                // what the child resolves through its parent just changed
                settingsEpoch.n++;
            }
        }
        this.createRoute("USE", /** @type {string|RegExp|(string|RegExp)[]} */ (path), this, ...callbacks);
        return this;
    }

    /**
     * Registers a websocket route, served by uWS itself. The behavior is uWS's, plus an
     * `upgrade(req, res)` that runs before the handshake with a real request and response:
     * answering declines the socket, a returned promise holds the handshake. The request lives as
     * long as the socket, as `ws.req`.
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
        // one route as far as an error is concerned, see errorHop
        const group = ++routeGroups;
        const fns = new NullObject();
        // one map and one stack for the chain, express builds one Route for it
        const groupMethods = new NullObject();
        /** @type {(Omit<Layer, "route"> & {method: string|undefined})[]} express's Route#stack, see createRoute */
        const groupStack = [];
        fns.path = path;
        fns.methods = groupMethods;
        fns.stack = groupStack;
        /**
         * @param {string} method
         * @param {unknown[]} callbacks
         */
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
            fns[method] = (/** @type {unknown[]} */ ...callbacks) => inGroup(method, callbacks);
        }
        fns.get = (/** @type {unknown[]} */ ...callbacks) => inGroup("GET", callbacks);
        return fns;
    }

    /**
     * Answers with an error page: no sniffing, no ETag, a CSP that allows nothing.
     *
     * @param {Request} request
     * @param {Response} response
     * @param {unknown} err whatever was thrown, which need not be an Error
     * @param {boolean} [checkEnv] whether production should redact it
     * @param {Record<string, any>} [carried] the headers the error asked for, written last
     */
    _sendErrorPage(request, response, err, checkEnv = false, carried = undefined) {
        err = this._generateErrorPage(err, response.statusCode, checkEnv);
        request.noEtag = true;
        // a header that cannot be written may be what brought the request here
        response._dropUnwritableHeaders();
        // the content headers describe a body that is not this one
        response.removeHeader("Content-Encoding");
        response.removeHeader("Content-Language");
        response.removeHeader("Content-Range");
        for (const name in carried) {
            response.setHeader(name, carried[name]);
        }
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy", "default-src 'none'");
        response.send(err);
    }

    /**
     * The automatic OPTIONS reply from the verbs the walk collected. Throws once the head is out,
     * as node's setHeader would.
     *
     * @param {Request} request
     * @param {Response} response
     * @param {Set<string>} methods the verbs the answering router knows, which are its own
     */
    _sendOptionsReply(request, response, methods) {
        if (response.headersSent) {
            throw headersSentError("set");
        }
        // sorted, as Express 5 writes it
        const allowedMethods = Array.from(methods).sort().join(", ");
        response.setHeader("Allow", allowedMethods);
        // as the router package answers it: plain text, nosniff, end() so no ETag
        response.setHeader("Content-Type", "text/plain");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.end(allowedMethods);
    }

    /**
     * How a request nothing answered ends: its error, the automatic OPTIONS reply, or a 404. Every
     * path ends here.
     *
     * @param {Request} request
     * @param {Response} response
     */
    _endUnmatched(request, response) {
        if (request._error) {
            return this._handleError(request._error, null, request, response);
        }
        if (request._isOptions && request._matchedMethods !== null && request._matchedMethods.size > 0) {
            try {
                this._sendOptionsReply(request, response, request._matchedMethods);
            } catch (err) {
                this._handleError(err, null, request, response);
            }
            return;
        }
        response.status(404);
        // the pathname of originalUrl, as finalhandler prints it
        const originalUrl = String(request.originalUrl);
        const queryIndex = originalUrl.indexOf("?");
        const pathname = queryIndex === -1 ? originalUrl : originalUrl.slice(0, queryIndex);
        this._sendErrorPage(request, response, `Cannot ${request.method} ${pathname}`, false);
    }
};

// the optimizer needs the class to tell a mounted router from a plain handler
useRouterClass(module.exports);

// the verb methods on the prototype: as own arrows they closed over the instance they were built
// on, and express.Router().post(...) answered with the object the callable was copied from

for (const method of methods) {
    module.exports.prototype[method] = function (
        /** @type {string|RegExp|(string|RegExp)[]} */ path,
        /** @type {unknown[]} */ ...callbacks
    ) {
        return this.createRoute(method, path, this, ...callbacks);
    };
}
