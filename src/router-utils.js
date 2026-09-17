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

const { getPatternMeta, pathsCanOverlap, regexpGroupKeys, EMPTY_REGEX } = require("./utils.js");
const Response = require("./response.js");
const Request = require("./request.js");
const { METHODS } = require("http");

/** @typedef {import("./walk.js")} Walk */
/** @typedef {import("./router.js")} Router */
/**
 * One entry of a router's table as createRoute builds it, loose: the optimizer hangs more fields
 * on it after registration.
 * @typedef {any} RouteEntry
 */
/**
 * The constants every request to a literal registration shares, see nativePreset.
 * @typedef {object} NativePreset
 * @property {string} path
 * @property {string} method
 * @property {boolean} endsWithSlash
 * @property {string} opPath
 * @property {boolean} isOptions
 * @property {boolean} isHead
 * @property {boolean} skipHeaders taken back by a middleware added after listen, see _skipPresets
 * @property {boolean} skipQuery the same, for the query
 */
/**
 * Where a granted header skip lives: the preset for a literal registration, a holder of its own
 * for a parameterised one, see makeHandler in optimizer.js.
 * @typedef {object} SkipHolder
 * @property {boolean} skipHeaders
 * @property {boolean} skipQuery
 * @property {string|null} [method]
 * @property {boolean} [isOptions]
 * @property {boolean} [isHead]
 */
/**
 * An earlier registration a mount is guarded by, see guardsInside.
 * @typedef {{path: string, use: boolean, method: string, all: boolean}} MountGuard
 */
/**
 * A layer as express shapes it, for app.stack and router.stack.
 * @typedef {object} Layer
 * @property {Function} handle
 * @property {string} name
 * @property {undefined} params
 * @property {undefined} path
 * @property {never[]} keys
 * @property {RouteEntry|undefined} route
 */
/**
 * A websocket registration, kept until listen() hands it to µWS.
 * @typedef {{path: string, behavior: Record<string, unknown>, owner: Router}} WsRoute
 */

// whether a registered path could be asked for in another case, see _optimizeRoute
const HAS_LETTER = /[a-zA-Z]/;

/**
 * Whether an earlier route would have answered this path had case not mattered: a folded string
 * for a literal, an insensitive pattern for a path with parameters. The string is compared
 * character by character, not through toLowerCase: saying no must allocate nothing on this path.
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
        // a registered path also answers with one trailing slash under the default routing, so
        // "/X1/" is a case variant of "/x1" as much as "/X1". Erring wide costs nothing, a hit only
        // hands the request to the generic router
        const slashed = path.length === guard.length + 1 && path.charCodeAt(guard.length) === 0x2f;
        if (guard.length !== path.length && !slashed) {
            continue;
        }
        let same = true;
        for (let j = 0; j < guard.length; j++) {
            let code = path.charCodeAt(j);
            // A to Z only, express's fold
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

// every method the declarative compiler can emit: a patched one disables compilation
const resCodes = {},
    resDecMethods = ["set", "setHeader", "header", "send", "end", "append", "status", "json", "sendStatus"];
for (const method of resDecMethods) {
    resCodes[method] = Response.prototype[method].toString();
}

/**
 * The layer Express makes for one mounted handler, with the name a caller matches on.
 *
 * @param {RouteEntry} route
 * @param {Function & {_routes?: RouteEntry[], _isApplication?: boolean}} callback a handler or a
 *   mounted router
 * @returns {Layer}
 */
function layerFor(route, callback) {
    const layer = {
        handle: callback,
        // express names its own handles "app" and "router"
        name: Array.isArray(callback._routes)
            ? callback._isApplication
                ? "app"
                : "router"
            : callback.name || "<anonymous>",
        params: undefined,
        path: undefined,
        keys: [],
        route: undefined
    };
    route._layers.set(callback, layer);
    return layer;
}

/**
 * The layer Express makes for a route: a handle named `handle` running the route's handlers.
 *
 * @param {RouteEntry} route
 * @returns {Layer}
 */
function routeLayer(route) {
    /**
     * @param {Request} req
     * @param {Response} res
     * @param {(err?: unknown) => void} next
     */
    const handle = function handle(req, res, next) {
        let index = 0;
        /** @param {unknown} [err] */
        const step = (err) => {
            const callback = route.callbacks[index++];
            if (callback === undefined) {
                return next(err);
            }
            const isErrorHandler = callback.length === 4;
            if ((err === undefined || err === null) === isErrorHandler) {
                return step(err);
            }
            try {
                return isErrorHandler ? callback(err, req, res, step) : callback(req, res, step);
            } catch (thrown) {
                return step(thrown);
            }
        };
        step();
    };
    return { handle, name: "handle", params: undefined, path: undefined, keys: [], route: route.exposed };
}

/**
 * The native handler's resolve, this.resolve(matched) with the walk as receiver: the promise
 * _routeRequest allocates is for callers that await, and the uWS handler never did. The 404
 * epilogue stays on a microtask, so a middleware writing after next() still wins headersSent.
 * @this {Walk}
 * @param {RouteEntry|false} matched what the walk ended on, as the resolve receives it
 */
function nativeDone(matched) {
    if (this.settled) {
        return;
    }
    this.settled = true;
    if (!matched) {
        queueMicrotask(() => {
            const response = this.res;
            // a 404 after the head is left as it is, an error after it closes the connection, as
            // express's final handler does
            if (response.aborted || (response.headersSent && !this.req._error)) {
                return;
            }
            try {
                this.router._endUnmatched(this.req, response);
            } catch (err) {
                if (response.aborted || response.finished) {
                    logError(this.router, err);
                } else {
                    this.router._handleError(err, null, this.req, response);
                }
            }
        });
    }
}

/**
 * The native handler's reject: a 500 as express's final handler, deferred like the resolve.
 * @this {Walk}
 * @param {unknown} err
 */
function nativeFail(err) {
    if (this.settled) {
        return;
    }
    this.settled = true;
    queueMicrotask(() => {
        const response = this.res;
        if (response.aborted || response.finished) {
            logError(this.router, err);
        } else {
            this.router._handleError(err, null, this.req, response);
        }
    });
}

/**
 * How much of the path a mount takes: what its own pattern matched, on the same fixed-up path
 * _pathMatches tested. Counted per mount and not composed over the stack: a mount written as an
 * optional group composes into a pattern the path no longer satisfies.
 *
 * @param {RouteEntry} route
 * @param {Request} req
 * @returns {number}
 */
function mountPrefixLength(route, req) {
    // pathless, most middleware is
    if (route.pattern === EMPTY_REGEX) {
        return 0;
    }
    // a literal mount's constant, see createRoute
    if (route.mountLen !== undefined) {
        return route.mountLen;
    }
    if (typeof route.pattern === "string") {
        return route.pattern.length;
    }
    const path = req._opPath;
    const matched = route.pattern.exec(path === "" ? "/" : path);
    return matched ? Math.min(matched[0].length, path.length) : 0;
}

/**
 * Writes the path the routes below a mount see, the root as "/" as express hands it over.
 *
 * @param {Request} req
 */
function setMountedPath(req) {
    req._opPath = req._consumed === 0 ? req._originalPath : req._originalPath.slice(req._consumed);
    req._opPathLower = null;
    req.url = req._opPath === "" ? "/" + req.urlQuery : req._opPath + req.urlQuery;
    req._path = req._opPath === "" ? "/" : req._opPath;
    req._lastUrl = req.url;
}

// req.path off the prototype, for an adopted plain request; enumerable as express's is
const PATH_PROPERTY = {
    .../** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Request.prototype, "path")),
    enumerable: true
};

// and the two the walk calls on a rewrite, which an adopted request has no prototype to find
const ABSORB_URL = Request.prototype._absorbUrlRewrite;
const ABSORB_METHOD = Request.prototype._absorbMethodRewrite;

const NO_PARAM_NAMES = /** @type {string[]} */ ([]);

/**
 * The parameter names a route captures with its own pattern, the set express runs param
 * callbacks for. A name inherited through mergeParams belongs to the mount's router: reading
 * req.params ran a callback for it too and turned a 200 into a 500. Kept per route.
 *
 * @param {RouteEntry} route
 * @returns {string[]}
 */
function ownParamNames(route) {
    let names = route._ownParamNames;
    if (names !== undefined) {
        return names;
    }
    if (route.optimizedParams) {
        names = route.optimizedParams;
    } else if (route.pattern instanceof RegExp) {
        const meta = getPatternMeta(route.pattern);
        // outputNames is what _extractParams writes; an application's RegExp has its groups
        names = meta ? meta.outputNames : regexpGroupKeys(route.pattern);
    } else {
        names = NO_PARAM_NAMES;
    }
    route._ownParamNames = names;
    return names;
}

/**
 * Whether this route's own router asks for the mounts' parameters: express asks each router in
 * turn, a plain router inside a mergeParams one does not read them.
 *
 * @param {RouteEntry} route
 * @param {Router} fallback the router dispatching, when the route names no owner
 * @returns {boolean}
 */
function mergesParams(route, fallback) {
    const owner = route.owner ?? fallback;
    return Boolean(owner?._settings?.mergeParams);
}

const EMPTY_INDICES = /** @type {number[]} */ ([]);

/**
 * The generic scan's index: route positions by folded literal pattern, everything else ("/*"
 * included) in alwaysVisit.
 *
 * @param {RouteEntry[]} routes the router's own table
 * @param {boolean} caseFlag the frozen case-sensitivity flag
 * @returns {{map: Map<string, number[]>, alwaysVisit: number[]}}
 */
function buildLiteralIndex(routes, caseFlag) {
    const map = new Map();
    const alwaysVisit = [];
    for (let i = 0; i < routes.length; i++) {
        const pattern = routes[i].pattern;
        if (typeof pattern === "string" && pattern !== "/*") {
            const key = caseFlag ? pattern : routes[i].patternLower;
            const list = map.get(key);
            if (list === undefined) {
                map.set(key, [i]);
            } else {
                list.push(i);
            }
        } else {
            alwaysVisit.push(i);
        }
    }
    return { map, alwaysVisit };
}

/**
 * The position of the first value >= from in an ascending list, list.length when there is none.
 *
 * @param {number[]} list
 * @param {number} from
 * @returns {number}
 */
function firstAtLeast(list, from) {
    let low = 0;
    let high = list.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (list[mid] < from) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}

/**
 * The route's own params merged with the mounts', outer first, own last. Numbered captures
 * shift rather than overwrite, as in express.
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
 * The scheme and authority of an absolute request target, "" for the ordinary kind: express
 * matches on the path and leaves req.url as it arrived.
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
 * Fills in what dispatch reads on a plain object driven through `router.handle({ url, method })`,
 * as express's own tests do. req.url becomes an accessor: the router writes plain paths, a
 * reader sees the absolute URI, and the protohost stays out of the dispatch.
 *
 * @param {any} req the plain object a caller drove the router with, not one of our requests
 * @param {Router} router
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
    req._path = path;
    Object.defineProperty(req, "path", PATH_PROPERTY);
    req._absorbUrlRewrite = ABSORB_URL;
    req._absorbMethodRewrite = ABSORB_METHOD;
    req.originalUrl = req.originalUrl ?? arrived;
    req._originalPath = path;
    req.endsWithSlash = path.charCodeAt(path.length - 1) === 0x2f;
    req._opPath = path;
    req._opPathLower = null;
    req._mayFailDecode = null;
    req._lastUrl = req.url;
    req._lastMethod = req.method;
    req._isOptions = req.method === "OPTIONS";
    req._isHead = req.method === "HEAD";
    req.params = req.params ?? Object.create(null);
    // null as in the Request constructor, the push sites materialise them
    req._stack = null;
    req._consumed = 0;
    req._mountSlash = false;
    req._paramStack = null;
    req._matchedMethods = req._isOptions ? new Set() : null;
    req.routeCount = 1;
    req.app = req.app ?? router;
}

/**
 * express's logerror: the stack of the error about to be answered, quiet under `env: "test"`.
 *
 * @param {Router} router the router whose settings decide it
 * @param {any} err whatever was thrown, which need not be an Error
 * @returns {void}
 */
function logError(router, err) {
    if (err && router.get("env") !== "test") {
        console.error(err.stack || err.toString());
    }
}

/**
 * The uWS onAborted handler, bound to the response rather than a closure per request.
 * @this {Response}
 */
function onNativeAborted() {
    const response = this;
    const request = response.req;
    // node's wording, what body consumers match on
    /** @type {NodeJS.ErrnoException} */
    const err = new Error("aborted");
    err.code = "ECONNRESET";
    response.aborted = true;
    response.finished = true;
    // node's order: 'aborted', the response destroyed ('close' once, a later write
    // ERR_STREAM_DESTROYED, no 'error'), then the request. The error only to a listener, a
    // destroy(err) without one takes down the process
    request.emit("aborted");
    response.destroy();
    request.destroy(request.listenerCount("error") > 0 ? err : undefined);
    response.socket?.emit("error", err);
}

/**
 * The constants of a literal native registration, which the request constructor takes as given.
 *
 * @param {string} path the registered pattern
 * @param {string} method uppercase
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
        // granted at registration, taken back by a middleware added after listen
        skipHeaders: false,
        skipQuery: false
    };
}

/**
 * Whether any error middleware exists under this router, sub-apps included: a throw would hand
 * the request to code the header-skip analysis never saw.
 *
 * @param {Router} router
 * @returns {boolean}
 */
function hasErrorMiddleware(router) {
    for (const route of router._routes) {
        for (const callback of route.callbacks) {
            // a callable sub-app is also a function, so the routes are looked for first
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
 * @param {unknown[]} handlers what a registration was given, flattened
 * @param {string} [emptyMessage]
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

// what a route's callback is, a number per hop instead of instanceof and length
const CALLBACK_PLAIN = 0;
const CALLBACK_ERROR = 1;
const CALLBACK_ROUTER = 2;

/**
 * Reports a parameter that will not decode, unless something is already being reported: express
 * keeps the first error (`layerError = layerError || match`). Overwriting replaced express.static's
 * Bad Request with the decode failure of a route further down that never ran. Found by the fuzzer.
 *
 * @param {Request} req
 * @param {RouteEntry} route
 * @param {unknown} err whatever decoding threw
 */
function raiseDecodeFailure(req, route, err) {
    if (req._error) {
        return;
    }
    req._error = err;
    req._errorKey = route.routeKey;
    req._errorGroup = route.group;
}

// the verbs the parsers read a body for unless "body methods" says otherwise
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "QUERY"]);

/**
 * Whether a body parser can be skipped for this request: it said nothing about a body (no
 * content-length, not even 0, no transfer-encoding) and the verb reads none. A hop costs 367us per
 * thousand requests against the 38 of the parser prologue it skips. Fusing consecutive layers was
 * counted over a real front and does not pay: the longest fusable run is one layer.
 *
 * @param {RouteEntry} route
 * @param {Request} req
 * @returns {boolean}
 */
function stepsOver(route, req) {
    if (route.bodyParserOnly !== true || req._hasBodyHeaders === true) {
        return false;
    }
    if (BODY_METHODS.has(req.method)) {
        return false;
    }
    // read once, as the parser does: per request it measured 17us per thousand, a third of the saving
    if (route.bodyMethods === undefined) {
        route.bodyMethods = req.app.get("body methods") ?? null;
    }
    if (route.bodyMethods !== null && route.bodyMethods.includes(req.method)) {
        return false;
    }
    // the one mark the parser would have left, `"body" in req`, see middlewares.js
    if (!("body" in req)) {
        /** @type {{body?: unknown}} */ (req).body = undefined;
    }
    return true;
}

/**
 * Whether a route could answer this path: a literal only itself, a pattern what its regex says.
 *
 * @param {RouteEntry} route
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
 * Whether a layer written before a mount could answer a path inside it: `/a` and `/:p0/:p1/:p2`
 * share no text and both answer `/a/x/y`, and such a leaf must stay on the generic path since uWS
 * jumps straight to it. Only layers with more segments than the mount reach this. A wrong yes
 * costs a leaf its native registration and nothing else.
 *
 * @param {{path: string, use: boolean, method: string, all: boolean}} guard
 * @param {string} leafPath the leaf's absolute path, parameters and all
 * @param {RouteEntry} leaf
 * @returns {boolean}
 */
function shadowsLeaf(guard, leafPath, leaf) {
    if (!guard.all && guard.method !== leaf.method && !(guard.method === "HEAD" && leaf.method === "GET")) {
        return false;
    }
    return pathsCanOverlap(guard.path.toLowerCase(), leafPath.toLowerCase(), guard.use);
}

/**
 * The layers before a mount that answer some of what is inside it and not all of it, which neither
 * the chain nor uWS's specificity can say. Carried down the walk and asked about every leaf, see
 * shadowsLeaf.
 *
 * @param {Router} router the router the mount belongs to
 * @param {RouteEntry} mount
 * @param {string} pathPrefix what the mounts above this one consumed
 * @param {RouteEntry[]} chain the layers that always run before the mount, which need no guard
 * @param {MountGuard[]} inherited the guards from further out, since a mount two levels down is under
 *   everything written before either of them
 * @returns {MountGuard[]|null} null when a path cannot be read segment by segment, which leaves the mount
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
 * Notes which application is current before a mounted one is entered, so that exact one comes
 * back, not the entered one's parent: those differ under a plain Router, and `.parent` skipped a
 * level (a 404 carried an ETag under etag false, found by the fuzzer). Only an application takes
 * it back, as express restores req.app only in Application#use. The route is kept alongside.
 *
 * @param {Walk} walk
 * @param {RouteEntry} route
 * @param {Request} req
 */
function rememberApp(walk, route, req) {
    if (walk.router._isApplication && route.callbacks[0]?._isApplication) {
        (req._appStack ??= []).push(route, req.app);
    }
}

/**
 * Puts back what rememberApp noted, if this is the route that noted it.
 *
 * @param {RouteEntry} route
 * @param {Request} req
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
 * An application takes the request over, see rememberApp.
 * @param {Request} req
 * @param {Router & {request?: object, response?: object}} app typed as a router because the
 *   callers hold one
 */
function useApp(req, app) {
    req.app = /** @type {import("./application.js").Application} */ (app);
    if (req.res) {
        req.res.app = app;
    }
    // the app's own request and response layers, as express re-parents both on entering a sub-app
    if (app.request && Object.getPrototypeOf(req) !== app.request) {
        Object.setPrototypeOf(req, app.request);
    }
    if (app.response && req.res && Object.getPrototypeOf(req.res) !== app.response) {
        Object.setPrototypeOf(req.res, app.response);
    }
}

// every verb node knows, as the methods package hands Express, plus "all". Not GET: get() is
// declared in the class, it doubles as the settings reader
const methods = ["all", ...METHODS.filter((method) => method !== "GET").map((method) => method.toLowerCase())];
const supportedUwsMethods = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "CONNECT", "TRACE"]);

// the same name rule patternToRegex reads, so a unicode name is found here too
const regExParam = /:([$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*)/gu;

// internals are _underscore, not #private: a callable router copies the properties onto a
// function, and a # field cannot be copied

// one intermediate prototype per class
const callablePrototypes = new WeakMap();

/**
 * The prototype for a callable router or app: the class prototype with apply and call put back,
 * since a function's prototype set to it drops Function.prototype. Not bind: BIND is an HTTP verb,
 * app.bind registers a route as in Express.
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
            value: Function.prototype[name],
            writable: true,
            configurable: true,
            enumerable: false
        });
    }
    callablePrototypes.set(classPrototype, prototype);
    return prototype;
}

/**
 * Express's default error page, the stack in a pre. Escaped: a message can carry anything a
 * client sent, and the CSP is a second line, not the first.
 *
 * @param {any} err whatever was thrown, which need not be an Error
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

module.exports = {
    HAS_LETTER,
    anyGuardHits,
    resCodes,
    resDecMethods,
    layerFor,
    routeLayer,
    nativeDone,
    nativeFail,
    mountPrefixLength,
    setMountedPath,
    ownParamNames,
    mergesParams,
    EMPTY_INDICES,
    buildLiteralIndex,
    firstAtLeast,
    mergeParams,
    adoptPlainRequest,
    logError,
    onNativeAborted,
    nativePreset,
    hasErrorMiddleware,
    checkHandlers,
    CALLBACK_PLAIN,
    CALLBACK_ERROR,
    CALLBACK_ROUTER,
    raiseDecodeFailure,
    stepsOver,
    couldAnswer,
    shadowsLeaf,
    guardsInside,
    rememberApp,
    restoreApp,
    useApp,
    methods,
    supportedUwsMethods,
    regExParam,
    callablePrototypeFor,
    generateErrorPageHtml
};
