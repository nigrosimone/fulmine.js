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
 * One entry of a router's table, as createRoute in router.js builds it. Left loose on purpose: the
 * optimizer hangs half a dozen more fields on it after registration, and writing them all out here
 * would be a second copy of createRoute that nothing keeps in step.
 * @typedef {any} RouteEntry
 */
/**
 * What nativePreset builds for a literal registration: the constants every request to that route
 * shares, read off the preset instead of the URL.
 * @typedef {object} NativePreset
 * @property {string} path
 * @property {string} method
 * @property {boolean} endsWithSlash
 * @property {string} opPath
 * @property {boolean} isOptions
 * @property {boolean} isHead
 * @property {boolean} skipHeaders written at registration, and taken back by a middleware added
 *   after listen, see _skipPresets
 * @property {boolean} skipQuery the same, for the query
 */
/**
 * Where a granted header skip lives: the preset itself for a literal registration, a holder of its
 * own for a parameterised one, see makeHandler in optimizer.js.
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
 * A layer as express shapes it, which is what app.stack and router.stack hand out.
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

// whether a registered path could be asked for in another case, which is what decides whether the
// native router can be trusted to prefer it, see _optimizeRoute
const HAS_LETTER = /[a-zA-Z]/;

/**
 * Whether an earlier route would have answered this path had case not mattered. A guard is a
 * folded string when the earlier path is a literal, and an insensitive pattern when it has
 * parameters of its own.
 *
 * The string side is compared character by character rather than through toLowerCase: it sits on
 * the hot path of every parameter route with an earlier literal, and saying no must allocate
 * nothing.
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
        // with one trailing slash too: "/x1" registered serves "/x1/", so "/X1/" is as much a case
        // variant of it as "/X1". Missing that answered "/X1/" from the parameter route behind it
        // while express answered from the literal. The regex guards are built non-strict and
        // already accept it. Erring wide costs nothing: a guard that hits only hands the request
        // to the generic router
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

/**
 * The layer Express makes for one mounted handler. `name` is what a caller matches on: a function's
 * own name, "router" for a mounted router, and "<anonymous>" for the rest, exactly as express reads
 * them off the handle.
 *
 * @param {RouteEntry} route
 * @param {Function & {_routes?: RouteEntry[], _isApplication?: boolean}} callback a handler, or a
 *   mounted router, which is callable and carries _routes
 * @returns {Layer} the layer object, which is express's shape and not one of ours
 */
function layerFor(route, callback) {
    const layer = {
        handle: callback,
        // express reads the name off the handle, and its own handles are named: a mounted
        // application is "app" and a mounted router "router", whatever this project happens
        // to call the function underneath
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
 * The layer Express makes for a route, whose handle runs the route's own handlers one after
 * another. Express calls that handle `handle`, and a caller that looks for a route layer looks for
 * that name.
 *
 * @param {RouteEntry} route
 * @returns {Layer} the layer object, which is express's shape and not one of ours
 */
function routeLayer(route) {
    const handle = function handle(req, res, next) {
        let index = 0;
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
 * The native handler's resolve, invoked as this.resolve(matched) with the walk as receiver. The
 * promise pair _routeRequest allocates exists for callers that await; the uWS handler never did,
 * and on the common path that promise never even settled: an async frame and two promises of
 * floating garbage per request.
 *
 * The 404 epilogue stays on a microtask, where the await used to resume: a middleware that writes
 * after calling next() must still win the headersSent check, as it does in express.
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
            // a 404 after the head is left as it is, as express's final handler leaves it; an error
            // after it goes on to _handleError, which closes the connection as that handler does
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
            logError(this.router, err);
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
 * Counting what each mount took, rather than composing one pattern out of the whole stack, is the
 * difference between a sum and a guess: a mount written as an optional group composes into a
 * pattern the path no longer satisfies, and the prefix stayed on.
 *
 * @param {RouteEntry} route
 * @param {Request} req
 * @returns {number}
 */
function mountPrefixLength(route, req) {
    // a use with no path is EMPTY_REGEX, which matches "" at 0 whatever the path is. Answered
    // without the exec, since this runs per hop and most middleware is pathless
    if (route.pattern === EMPTY_REGEX) {
        return 0;
    }
    // the registration-time constant of a literal mount, exec-free. See createRoute
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
 * Writes the path the routes below a mount see: the original with what the mounts took off the
 * front. The root reads as "/" rather than as nothing, which is how express hands it over.
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

// req.path as the request class declares it, taken off the prototype rather than written out a
// second time. A request the router adopts is a plain object and gets it defined on itself, see
// adoptPlainRequest. Enumerable, as express's own is.
const PATH_PROPERTY = {
    .../** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Request.prototype, "path")),
    enumerable: true
};

// and the two the walk calls when a middleware rewrote req.url or req.method, for the same reason:
// an adopted request has no prototype of ours to find them on, and a rewrite through one of those
// routers threw instead of being taken over
const ABSORB_URL = Request.prototype._absorbUrlRewrite;
const ABSORB_METHOD = Request.prototype._absorbMethodRewrite;

const NO_PARAM_NAMES = [];

/**
 * The parameter names a route captures with its own pattern.
 *
 * This is the set express runs param callbacks for. A name that reached req.params from a mount
 * above, through mergeParams, belongs to that mount's router: express walks the keys the layer
 * itself matched. Reading req.params instead ran a callback for every inherited name too, and
 * turned a 200 into a 500 when one of them refused the value.
 *
 * Worked out once per route and kept, since it follows from the pattern.
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
        // µWS matched the pattern and hands the values back by position, under these names
        names = route.optimizedParams;
    } else if (route.pattern instanceof RegExp) {
        const meta = getPatternMeta(route.pattern);
        // outputNames is what _extractParams writes into params; a RegExp the application wrote
        // itself was never compiled here, so its capture groups are the names
        names = meta ? meta.outputNames : regexpGroupKeys(route.pattern);
    } else {
        names = NO_PARAM_NAMES;
    }
    route._ownParamNames = names;
    return names;
}

/**
 * Whether this route reads the parameters of the mounts above it, which is its own router asking
 * for them. The stack holds what a mergeParams router captured on the way in, and a plain router
 * mounted inside one must not read it: express asks each router in turn, not the outermost.
 *
 * @param {RouteEntry} route
 * @param {Router} fallback the router dispatching, when the route names no owner
 * @returns {boolean}
 */
function mergesParams(route, fallback) {
    const owner = route.owner ?? fallback;
    return Boolean(owner?._settings?.mergeParams);
}

// shared empty candidate list, so _scanFrom never tests for a missing map entry twice
const EMPTY_INDICES = /** @type {number[]} */ ([]);

/**
 * The generic scan's index over a router's literal routes: route positions by folded pattern, so
 * a scan visits the routes registered for this exact path instead of comparing every one. String
 * patterns are pure literals, everything else, "/*" included, stays in alwaysVisit and is still
 * matched per request by _pathMatches.
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
 * The position of the first value >= from in an ascending list, which is list.length when there
 * is none: where a scan resuming at `from` enters a candidate list.
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
 * Fills in what dispatch reads on a request that did not come from uWS.
 *
 * express's router can be driven with a plain object, `router.handle({ url, method }, res, next)`,
 * and its own tests do exactly that. Only ever called for such a request: one of ours arrives with
 * these fields already set.
 *
 * req.url becomes an accessor, so the router goes on writing plain paths to it while a reader sees
 * the absolute URI it arrived as, which keeps the protohost out of the dispatch.
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
    // an adopted request is a plain object, so it carries no prototype of ours and reads its path
    // off a property of its own. The class's getter itself, so there is one of it
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
    // null, not fresh arrays: the push sites materialize them on the first mount, and most
    // requests never see one, same as the Request constructor
    req._stack = null;
    req._consumed = 0;
    req._mountSlash = false;
    req._paramStack = null;
    req._matchedMethods = req._isOptions ? new Set() : null;
    req.routeCount = 1;
    // read when a mount is left, and there is no application here to read it from
    req.app = req.app ?? router;
}

/**
 * What express's logerror does. Its final handler prints the error it is about to answer with,
 * unless the application runs under `env: "test"`, which is how its own suite stays quiet, and it
 * prints the stack rather than the object. A falsy throw is not printed at all, since finalhandler
 * only calls onerror when there is an error to call it with.
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
 * The uWS onAborted handler, bound to the response: a closure here captured two locals and cost
 * a context plus a function per request, for a path that only ever runs on a client abort.
 * @this {Response} the response, with the request linked as this.req
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
    // and the response dies between the two, which is where node puts it. Destroyed rather than
    // told to emit 'close', because being destroyed is the state express is in here and the rest
    // follows from it: 'close' goes out once, a later res.write returns false and calls back with
    // ERR_STREAM_DESTROYED, and no 'error' is emitted.
    //
    // Without this a handler learnt about the abort only from a write failing, so one that had sent
    // its head and gone quiet never learnt at all. `res.on("close")` is where cancellation hangs in
    // every proxy and every streaming endpoint
    response.destroy();
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
 * @param {Router} router
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
 * Reports a parameter that will not decode, unless something is already being reported.
 *
 * Matching a route decodes its parameters, and that happens while the walk is still looking for
 * whoever should answer. Express keeps the first error it has: `layerError = layerError || match`
 * in its router. Overwriting meant express.static's Bad Request on an escape it could not decode
 * was replaced by the decode failure of a route further down that was never going to run. Found by
 * fuzzing route tables against express.
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

// the verbs a body is read for unless the application says otherwise, which is the parsers' own
// list. A request with any other verb reaches a parser's method check and leaves through it
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "QUERY"]);

/**
 * Whether this layer can be stepped over for this request without changing a thing.
 *
 * Only the body parsers are ever asked. Their prologue leaves a request that said nothing about a
 * body alone, whatever content type it carries, which is what `kGetSafe` records. Two conditions
 * on top of that mark, and both are needed:
 *
 * The request must have said nothing about framing at all, a `content-length: 0` included. A parser
 * that can see a length answers about the body it describes even when that body is empty: a zero
 * length with a charset nobody can decode is a 415, in express and here.
 *
 * And the verb must be one no parser reads a body for. With no length and no transfer-encoding a
 * POST still walks into the read, comes back with nothing, and leaves `req.body` as the empty value
 * its parser produces, which a handler can see.
 *
 * What it is worth: a hop measured 367us per thousand requests and the parser prologue it reaches
 * measured 38, ten to one for a layer that had nothing to do.
 *
 * That number is why fusing consecutive layers into one generated function keeps coming up, and why
 * it is not here. Counted over a real front (morgan, helmet, compression, cors, the two body
 * parsers, express-session, one of one's own, express.static): three of the nine can be fused, and
 * the longest run of fusable ones in a row is one, where fusing needs two. The six that fail all
 * call next from inside a callback, reading a body, stat-ing a file, loading a session, so no
 * design that keeps the semantics can fuse them.
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
    // an application can add its own. Read once and kept, which is what the parser behind this
    // layer does with the same setting: asking on every request measured 17 microseconds per
    // thousand, a third of what stepping over the layer saves
    if (route.bodyMethods === undefined) {
        route.bodyMethods = req.app.get("body methods") ?? null;
    }
    if (route.bodyMethods !== null && route.bodyMethods.includes(req.method)) {
        return false;
    }
    // The layer is not entered, so it leaves the one mark it would have left: the parser puts
    // `body` on the request before it works out that there is nothing to read. A library asks
    // `"body" in req` to tell "a parser has run" from "none has", and a skip that did not leave
    // it would answer a GET differently from express. See the same seeding in middlewares.js
    if (!("body" in req)) {
        // cast because `body` is deliberately not a field of Request, see the comment there
        /** @type {{body?: unknown}} */ (req).body = undefined;
    }
    return true;
}

/**
 * Whether a route could answer a request for this path, judged on the pattern it was compiled to.
 * A literal answers only itself; anything with a parameter or a wildcard answers what its regex
 * says. Used where the question is "would this earlier route have had its turn first".
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
 * Whether a layer written before a mount could answer a request for one of the paths inside it.
 *
 * A mount covers everything under its path, so this is a question about a subtree and not about the
 * mount point: `/a` and `/:p0/:p1/:p2` match none of each other's text and both answer `/a/x/y`.
 * uWS jumps straight to whichever leaf it registered, so a leaf a layer like this could have
 * answered has to stay on the generic path.
 *
 * Only layers with more segments than the mount path reach this: one with as few already matches
 * the mount point itself. Compared folded whichever way the routers are set, and a wrong yes costs
 * a leaf its native registration and nothing else.
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
 * The layers before a mount that answer some of what is inside it and not all of it, the one thing
 * neither the chain nor uWS's own choice can say: the chain runs what is in it without matching
 * again, and uWS picks by specificity. They are carried down the walk and asked about every leaf,
 * see shadowsLeaf.
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
 * Notes which application is current before a mounted one is entered, so that exact one comes back.
 *
 * Only an application takes it back. Express restores req.app by putting the request prototype
 * back, and it wraps a mounted application to do that only in Application#use: hang one off a plain
 * Router and nothing restores it. Restoring regardless made a later res.send answer with the outer
 * application's etag setting where express answers with the inner.
 *
 * And what comes back is what was current, not the entered application's parent. Those differ the
 * moment a sub-app is entered from inside another sub-app a plain Router mounted, and reaching for
 * `.parent` skipped a level: a 404 from the top application then carried an ETag under
 * `app.set("etag", false)`. Found by fuzzing three levels of routers.
 *
 * The route is remembered alongside, so the pop can only take back what this same route put there.
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
 * useApp
 * @param {Request} req
 * @param {Router & {request?: object, response?: object}} app the application taking the request
 *   over. Typed as a router because the callers hold one, and only an application carries the two
 *   prototype layers read below
 */
function useApp(req, app) {
    // only an application takes a request over, see rememberApp
    req.app = /** @type {import("./application.js").Application} */ (app);
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
 * The default error page, the one Express produces: the stack in a pre, and nothing else. What
 * reaches it has already been redacted when the environment calls for it.
 *
 * The text is escaped, which is not decoration. An error message can carry anything a client sent,
 * and writing it into the page unescaped put that into the markup. The Content-Security-Policy on
 * this response stops a script from running, but a policy is a second line and not the first.
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
