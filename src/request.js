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

const { deprecated, fastQueryParse } = require("./utils.js");
const accepts = require("accepts");
const typeis = require("type-is");
const parseRange = require("range-parser");
const proxyaddr = require("proxy-addr");
const fresh = require("fresh");
const parseQuery = require("./parse-query.js");
const { isIP } = require("node:net");
const { LazyReadable } = require("./lazy-readable.js");
const {
    asMessage,
    formatIPv6,
    isMappedIPv4,
    mapsIPv4Peer,
    emptyAddress,
    discardedDuplicates,
    KNOWN_METHODS,
    isAsciiTarget,
    endsWithChunked,
    saysClose,
    currentPath,
    isByteCount
} = require("./request-utils.js");

// whose headers #collectHeader is filling: uWS's forEach is synchronous, so one callback serves
// every request
let currentRequest = null;

module.exports = class Request extends LazyReadable {
    /** @type {import("http").IncomingHttpHeaders|null} */
    #cachedHeaders = null;

    /** @type {Record<string, string[]>|null} */
    #cachedDistinctHeaders = null;

    /**
     * Every header, flat: name then value, walked two at a time (an array per pair was one
     * allocation per header). Names are lowercase, uWS and the node shim both lower them.
     *
     * @type {string[]}
     */
    #rawHeadersEntries = [];

    /** @type {string|undefined|null} */
    #cachedParsedIp = null;

    /** Whether backpressure asked uWS to pause the body. */
    #paused = false;

    /** A bodyless request whose empty end has not been delivered yet, see the constructor. */
    #emptyBody = false;

    // `body` is not declared: on Express there is none until a parser assigns one, and tRPC asks
    // `"body" in req` to know whether the body was read. Its type is in types.d.ts

    /**
     * The response, linked right after construction. Loose: `Response|undefined` would put a
     * check in front of every use.
     *
     * @type {any}
     */
    res;

    /** @type {string[]|null} */
    #cachedSubdomains = null;

    /** The socket stand-in `req.connection` once built, see the getter. @type {import("./socket.js")|null} */
    #cachedConnection = null;

    /** Behind `req.signal`, made on the first read. @type {AbortController|undefined} */
    #abortController;

    /**
     * Copies one header out of uWS and notices what the constructor decides by. One function for
     * every request through currentRequest, an arrow per request cost a closure.
     *
     * @param {string} headerKey lowercase, as uWS hands it over
     * @param {string} value
     */
    static #collectHeader = (headerKey, value) => {
        const r = currentRequest;
        r.#rawHeadersEntries.push(headerKey, value);
        // the response, built right after, must not answer keep-alive to a client that said close
        if (headerKey.length === 10 && headerKey === "connection" && saysClose(value)) {
            r._connectionClose = true;
        } else if (
            (headerKey.length === 14 && headerKey === "content-length") ||
            (headerKey.length === 17 && headerKey === "transfer-encoding")
        ) {
            if (headerKey.length === 14) {
                // a second content-length, or one that is not a byte count, frames the request
                // differently from the wire, see _mustRefuse and isByteCount
                if (r._sawContentLength || !isByteCount(value)) {
                    r._mustRefuse = true;
                }
                r._sawContentLength = true;
            } else if (!endsWithChunked(value)) {
                r._mustRefuse = true;
            }
            // "0" included: a parser seeing a content-length answers about that body, an empty
            // one with a bad charset is a 415, so a chain may not step over it
            r._hasBodyHeaders = true;
            // content-length: 0 needs no onData subscription
            if (value !== "0" || headerKey.length === 17) {
                r._declaresBody = true;
            }
        }
    };

    /**
     * The parameters a native uWS route matched, by name, or undefined off that path.
     * @type {Record<string, string>|undefined}
     */
    optimizedParams;

    /**
     * Whether a body parser has already read this request, so a second one leaves it alone.
     * @type {boolean|undefined}
     */
    bodyRead;

    /**
     * The route currently running, which express hands to a handler through the request.
     * @type {any}
     */
    route;

    /**
     * Which hop the error being carried came from, so an earlier error handler does not catch it.
     * @type {number|undefined}
     */
    _errorKey;

    /**
     * Which app.route() the failing route belonged to: an error handler on it catches what its
     * siblings raised, as Express builds one route out of them.
     * @type {number|undefined}
     */
    _errorGroup;

    /**
     * How much of _originalPath the mounts entered so far have taken, as a count: what a mount
     * took is what it matched, a pattern rebuilt from the stack does not always match the same.
     * @type {number}
     */
    _consumed = 0;

    /**
     * next() as the router means it, the rest of the route skipped: where res.sendFile reports.
     * @type {((err?: unknown) => void)|undefined}
     */
    _leaveRoute;

    /**
     * What `readable` answers while there is no stream, see LazyReadable.
     * @type {boolean}
     */
    _readableFlag = true;

    /**
     * The peer address as uWS hands it, sixteen bytes or four. Declared although only sometimes
     * filled: a property on some requests and not others is a second shape.
     *
     * @type {ArrayBuffer|undefined}
     */
    rawIp;

    /**
     * Whether the request declared a body, content-length or transfer-encoding.
     * @type {boolean|undefined}
     */
    _declaresBody;

    /**
     * Whether the request said anything about framing, a content-length of "0" included: a parser
     * seeing one answers about that body, so a chain may not step over it.
     * @type {boolean|undefined}
     */
    _hasBodyHeaders;

    /**
     * Whether a content-length was already copied, so a second one is spotted.
     * @type {boolean|undefined}
     */
    _sawContentLength;

    /**
     * Whether this request is refused before routing, as node's parser does with a 400. Each shape
     * lets bytes uWS did not frame as this request be served as the next one, which is smuggling:
     * a repeated content-length (uWS frames on the first), one that is not a byte count (see
     * isByteCount), a method nobody defines (see KNOWN_METHODS).
     *
     * @type {boolean|undefined}
     */
    _mustRefuse;

    /**
     * Whether the client asked for the connection to be closed.
     * @type {boolean|undefined}
     */
    _connectionClose;

    /**
     * The continuation of the running chain, set by runRoute. Loose for the same reason as `res`.
     *
     * @type {any}
     */
    next;

    /**
     * What the chain threw or passed to next(err), waiting for an error handler.
     * @type {unknown}
     */
    _error;

    /**
     * Set by the paths that must not earn an ETag, res.sendFile's stream among them.
     * @type {boolean|undefined}
     */
    noEtag;

    /**
     * The decoded pairs of the first default-parser parse of req.query, flat; false after a
     * repeated key, which a flat replay cannot reproduce. See `get query`.
     * @type {string[]|false|undefined}
     */
    _querySnap;

    /**
     * The raw string _querySnap came from, a url rewrite replaces _rawQuery.
     * @type {string|undefined}
     */
    _querySnapRaw;

    /**
     * The uWS response, an inert stand-in once the request outlives it, see _detachFromResponse.
     * @type {import("uWebSockets.js").HttpResponse}
     */
    _res;

    /**
     * The uWS request, readable only during the constructor call.
     * @type {import("uWebSockets.js").HttpRequest}
     */
    _req;

    /** @type {import("./application.js").Application} */
    app;

    /**
     * How many routes this request entered, a microtask every 300 keeps a long chain off the stack.
     * @type {number}
     */
    routeCount = 1;

    /** The query string without its "?", "" for none. @type {string} */
    _rawQuery;

    /** The query string with its "?", "" for none, what req.url carries. @type {string} */
    urlQuery;

    /** The path `path` reads, relative to the current mount. @type {string} */
    _path;

    /** @type {string} */
    originalUrl;

    /** @type {string} */
    url;

    /** What the router last wrote to req.url: dispatch compares to notice a rewrite. @type {string} */
    _lastUrl;

    /** @type {boolean} */
    endsWithSlash;

    /** The path the routing scan matches, _originalPath minus what the mounts consumed. @type {string} */
    _opPath;

    /** The path as it arrived, a url rewrite replaces it. @type {string} */
    _originalPath;

    /** @type {string} */
    method;

    /** @type {boolean} */
    _isOptions;

    /** @type {boolean} */
    _isHead;

    /** What the router last saw as the method, to notice a rewrite as express does. @type {string} */
    _lastMethod;

    /**
     * The folded _opPath and the percent scan, built on the first hop that wants them and dropped
     * by every rewrite, see _pathMatches and Walk#dispatch.
     * @type {string|null}
     */
    _opPathLower = null;

    /** @type {boolean|null} */
    _mayFailDecode = null;

    /** @type {Record<string, any>} */
    params = {};

    /** The verbs a path answers, for an OPTIONS; null on every other method. @type {Set<string>|null} */
    _matchedMethods = null;

    /** What each app.param() callback was called with, per router, made on first use. @type {Map<any, Map<any, any>>|null} */
    _paramCalled = null;

    /**
     * What each mount entered took of _originalPath, negative for one that consumed the whole
     * path; made at its push site, see Walk#runRoute.
     * @type {number[]|null}
     */
    _stack = null;

    /** Whether a mount took a trailing slash, which only a RegExp mount can, see baseUrl. @type {boolean} */
    _mountSlash = false;

    /** The params of the mounts entered, outermost first, made at its push site. @type {Record<string, any>[]|null} */
    _paramStack = null;

    /** Route and app alternating, one pair per sub-app entered, see rememberApp. @type {any[]|undefined} */
    _appStack;

    /** Whether a body chunk arrived, true from the start when none was declared. @type {boolean} */
    receivedData = false;

    /** node's flag, false until the whole body arrived: on-finished reads it for body-parser. @type {boolean} */
    complete = false;

    /** What a middleware assigned to req.baseUrl, see the setter. @type {string|undefined} */
    _baseUrlOverride;

    /**
     * Built for every request: the headers are copied out because uWS only lends them for this
     * call, everything else waits until asked.
     *
     * @param {import("uWebSockets.js").HttpRequest} req the uWS request, readable only during this call
     * @param {import("uWebSockets.js").HttpResponse} res the uWS response
     * @param {import("./application.js").Application} app
     * @param {import("./router-utils.js").NativePreset} [preset] a literal native registration's
     *   constants: uWS matched that exact pattern and method, so both are known without asking
     * @param {import("./router-utils.js").SkipHolder} [skipHolder] where a granted header skip
     *   lives, the preset itself for a literal registration
     */
    constructor(req, res, app, preset, skipHolder) {
        super();
        this._res = res;
        this._req = req;
        if (skipHolder !== undefined && skipHolder.skipHeaders) {
            // The chain never reads a header, so only the ones that steer the framework are read:
            // body framing, keep-alive, the conditional pair. Seven named reads are flat at 0.75us
            // whatever is on the wire, the full copy is 1.16us at four headers, 1.61 at eight, 2.90
            // at sixteen. A GET that declares a body takes the full copy. accept is not read: the
            // error and 404 pages never negotiate
            const length = req.getHeader("content-length");
            const transferEncoding = req.getHeader("transfer-encoding");
            // Anything that says a word about framing takes the full copy, "0" included: getHeader
            // returns only the first of a repeated header, and a duplicate must be refused, see
            // _mustRefuse. An empty content-length reads as "" like a header never sent, and only
            // the full copy below refuses it
            if (length !== "" || transferEncoding !== "") {
                currentRequest = this;
                this._req.forEach(Request.#collectHeader);
                currentRequest = null;
            } else {
                const entries = this.#rawHeadersEntries;
                const connection = req.getHeader("connection");
                if (connection !== "") {
                    entries.push("connection", connection);
                    if (saysClose(connection)) {
                        this._connectionClose = true;
                    }
                }
                // send consults freshness whatever the etag setting, so the conditional pair is read
                const ifNoneMatch = req.getHeader("if-none-match");
                if (ifNoneMatch !== "") {
                    entries.push("if-none-match", ifNoneMatch);
                }
                const ifModifiedSince = req.getHeader("if-modified-since");
                if (ifModifiedSince !== "") {
                    entries.push("if-modified-since", ifModifiedSince);
                }
                // fresh() reads cache-control only after a conditional
                if (ifNoneMatch !== "" || ifModifiedSince !== "") {
                    const cacheControl = req.getHeader("cache-control");
                    if (cacheControl !== "") {
                        entries.push("cache-control", cacheControl);
                    }
                }
            }
        } else {
            currentRequest = this;
            this._req.forEach(Request.#collectHeader);
            currentRequest = null;
        }
        this.app = app;
        // both forms are asked for: with the "?" in req.url, raw for req.query. When the chain
        // provably reads neither the native call is skipped
        if (skipHolder !== undefined && skipHolder.skipQuery) {
            this._rawQuery = "";
            this.urlQuery = "";
        } else {
            // getQuery tells "/a" (undefined) from "/a?" (""), and Express keeps the lone "?" in req.url
            const rawQuery = req.getQuery();
            this._rawQuery = rawQuery ?? "";
            this.urlQuery = rawQuery === undefined ? "" : "?" + rawQuery;
            if (rawQuery !== undefined && rawQuery.length !== 0 && !isAsciiTarget(rawQuery)) {
                this._mustRefuse = true;
            }
        }
        if (preset) {
            // the registration's constants, two native crossings saved
            this._path = preset.path;
            this.originalUrl = preset.path + this.urlQuery;
            this.url = this.originalUrl;
            this._lastUrl = this.originalUrl;
            this.endsWithSlash = preset.endsWithSlash;
            this._opPath = preset.opPath;
            this._originalPath = preset.path;
            this.method = preset.method;
            this._isOptions = preset.isOptions;
            this._isHead = preset.isHead;
        } else {
            this._path = req.getUrl();
            // node refuses a non-ascii target before routing; a preset is a literal µWS matched
            if (!isAsciiTarget(this._path)) {
                this._mustRefuse = true;
            }
            this.originalUrl = this._path + this.urlQuery;
            this.url = this.originalUrl;
            // what the router last wrote to req.url: dispatch compares to notice a rewrite
            this._lastUrl = this.originalUrl;
            this.endsWithSlash = this._path.charCodeAt(this._path.length - 1) === 0x2f;
            this._opPath = this._path;
            this._originalPath = this._path;
            const rawMethod = req.getCaseSensitiveMethod();
            if (skipHolder !== undefined && rawMethod === skipHolder.method) {
                // the registration's constant byte for byte, any other spelling takes the check below
                this.method = rawMethod;
                this._isOptions = skipHolder.isOptions;
                this._isHead = skipHolder.isHead;
            } else {
                this.method = rawMethod.toUpperCase();
                // node knows a fixed set, uWS takes any token. Compared before the uppercasing:
                // node refuses "post", uWS folds it and serves it
                if (!KNOWN_METHODS.has(rawMethod)) {
                    this._mustRefuse = true;
                }
                this._isOptions = this.method === "OPTIONS";
                this._isHead = this.method === "HEAD";
            }
        }
        this._lastMethod = this.method;
        if (this._isOptions) {
            this._matchedMethods = new Set();
        }
        // reading the ip is slow in uWS and impossible once the response is over, so it is read up
        // front for the first hundred requests, and always once an app was seen asking too late
        if (app.needsIpAfterResponse) {
            this.rawIp = this._readRawIp();
        } else if (app._ipProbes < 100) {
            app._ipProbes++;
            this.rawIp = this._readRawIp();
        }

        // a body is on the wire only when declared, whatever the verb
        if (this._declaresBody) {
            this._subscribeBody();
        } else {
            this.receivedData = true;
            this.complete = true;
            // the null goes out from _read(): ending a Readable costs a tick nobody may ever need
            this.#emptyBody = true;
        }
    }

    /**
     * Subscribes to the uWS body stream, out of the constructor so a bodyless request allocates no
     * closure. Still during the constructor call: uWS only feeds a handler registered before the
     * route handler returns.
     */
    _subscribeBody() {
        this._res.onData((ab, isLast) => {
            this.receivedData = true;
            if (this.#responseEnded) {
                return;
            }
            // copied, uWS neuters `ab` when this returns. Buffer.from over a view, ab.slice(0)
            // allocates an ArrayBuffer per chunk
            const chunk = Buffer.from(new Uint8Array(ab));
            const accepted = this.push(chunk);
            // push() may end the response synchronously through a flowing-mode listener
            if (!accepted && !isLast && !this.#responseEnded) {
                this._res.pause();
                this.#paused = true;
            }
            if (isLast) {
                this.complete = true;
                this.push(null);
            }
        });
    }

    /**
     * One header by its lowercase name, off the raw entries: the body parsers ask three per
     * request, cheaper than building the headers object. Off the built object once it exists.
     *
     * @param {string} name lowercase
     * @returns {string|undefined}
     */
    _rawHeader(name) {
        if (this.#cachedHeaders !== null) {
            return /** @type {string|undefined} */ (this.#cachedHeaders[name]);
        }
        const entries = this.#rawHeadersEntries;
        for (let i = 0, len = entries.length; i < len; i += 2) {
            if (entries[i] === name) {
                return entries[i + 1];
            }
        }
        return undefined;
    }

    /**
     * The same with repeats folded as the headers object folds them. Not for set-cookie, whose
     * folded form is an array.
     *
     * @param {string} name lowercase
     * @returns {string|undefined}
     */
    _foldedHeader(name) {
        if (this.#cachedHeaders !== null) {
            return /** @type {string|undefined} */ (this.#cachedHeaders[name]);
        }
        const entries = this.#rawHeadersEntries;
        let value;
        for (let i = 0, len = entries.length; i < len; i += 2) {
            if (entries[i] === name) {
                if (value === undefined) {
                    value = entries[i + 1];
                } else {
                    if (discardedDuplicates.has(name)) {
                        continue;
                    }
                    value += (name === "cookie" ? "; " : ", ") + entries[i + 1];
                }
            }
        }
        return value;
    }

    /** Once the response is finished or aborted, uWS has no body left to hand over. */
    get #responseEnded() {
        return this.res?.finished || this.res?.aborted;
    }

    /**
     * node's `req.signal`, fired when the request is over: `@angular/ssr` reads it to give up a
     * render. Made on the first ask.
     *
     * @returns {AbortSignal}
     */
    get signal() {
        if (!this.#abortController) {
            const controller = new AbortController();
            this.#abortController = controller;
            const stop = () => controller.abort();
            if (this.res?.aborted || this.res?.finished) {
                stop();
            } else {
                // a client abort is reported on the request, never as a close on the response
                this.once("aborted", stop);
                this.once("close", stop);
            }
        }

        return this.#abortController.signal;
    }

    /**
     * The trailers of a chunked request, which µWebSockets.js does not surface.
     *
     * @returns {Record<string, string>}
     */
    get trailers() {
        return {};
    }

    /**
     * @returns {Record<string, string[]>}
     */
    get trailersDistinct() {
        return {};
    }

    /**
     * node's per-request socket timeout, which cannot change µWS's `uwsOptions.idleTimeout`. The
     * listener is registered as node's is.
     *
     * @param {number} msecs
     * @param {() => void} [callback]
     * @returns {this}
     */
    setTimeout(msecs, callback) {
        if (typeof callback === "function") {
            this.once("timeout", callback);
        }
        return this;
    }

    /** Readable's pull: uWS pushes, so this only lifts the backpressure a full queue put on it. */
    _read() {
        // first, so a bodyless stream still ends for a consumer arriving after the response
        if (this.#emptyBody) {
            this.#emptyBody = false;
            this.push(null);
            return;
        }
        if (this.#paused && !this.#responseEnded) {
            this.#paused = false;
            this._res.resume();
        }
    }

    /**
     * The part of the path the mounts entered so far consumed, "" at the top level.
     * @returns {string}
     */
    get baseUrl() {
        if (this._baseUrlOverride !== undefined) {
            return this._baseUrlOverride;
        }
        if (this._consumed === 0) {
            return "";
        }
        if (this._mountSlash !== true) {
            return this._originalPath.slice(0, this._consumed);
        }
        // Express drops one trailing slash off each mount before joining: a RegExp mount that took
        // "/a/" out of "/a//b" reads back as "/a"
        let out = "";
        let at = 0;
        // _mountSlash is only ever set beside a push, so the stack is there
        for (let taken of /** @type {number[]} */ (this._stack)) {
            // negative marks a mount that consumed the whole path, see the push in runRoute
            if (taken < 0) {
                taken = -taken;
            }
            const piece = this._originalPath.slice(at, at + taken);
            at += taken;
            out += piece.charCodeAt(taken - 1) === 0x2f ? piece.slice(0, -1) : piece;
        }
        return out;
    }

    /**
     * Middleware does assign to it, and Express keeps it writable. Apart from _originalPath: what
     * reads back changes, not what later routes match.
     */
    set baseUrl(x) {
        this._baseUrlOverride = x;
    }

    /**
     * The Host header, port attached, or the first entry of X-Forwarded-Host behind a trusted proxy.
     */
    get #authority() {
        const trust = this.app._hot().trustProxyFn;
        // parsedIp is connection.remoteAddress without the socket stand-in
        const isTrusted = !!(trust && trust(this.parsedIp, 0));
        const rawHeader = (isTrusted && this.headers["x-forwarded-host"]) || this.headers["host"];
        let host = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

        if (typeof host !== "string" || !host) return;
        host = host.trim();

        if (isTrusted) {
            const commaIndex = host.indexOf(",");
            if (commaIndex !== -1) {
                host = host.substring(0, commaIndex).trimEnd();
            }
        }

        return host || undefined;
    }

    /** The authority without the port, an IPv6 literal's colons left alone. */
    get #host() {
        const host = this.#authority;
        if (!host) return;

        const offset = host[0] === "[" ? host.indexOf("]") + 1 : 0;
        const portIndex = host.indexOf(":", offset);

        return portIndex !== -1 ? host.substring(0, portIndex) : host;
    }

    /**
     * The authority, port included; `hostname` is the same without the port.
     * @returns {string|undefined} undefined with no Host
     */
    get host() {
        return this.#authority;
    }

    /**
     * The host without the port.
     * @returns {string|undefined}
     */
    get hostname() {
        return this.#host;
    }

    /**
     * Always "1.1": uWS reports no version through this API.
     * @returns {string}
     */
    get httpVersion() {
        return "1.1";
    }

    /** @returns {number} */
    get httpVersionMajor() {
        return 1;
    }

    /** @returns {number} */
    get httpVersionMinor() {
        return 1;
    }

    /**
     * The client address, through X-Forwarded-For with "trust proxy" set.
     * @returns {string|undefined} undefined on a unix socket
     */
    get ip() {
        const trust = this.app._hot().trustProxyFn;
        if (!trust) {
            return this.parsedIp;
        }
        return proxyaddr(asMessage(this), trust);
    }

    /**
     * The trusted addresses from X-Forwarded-For, nearest client first, empty unless
     * "trust proxy" is set.
     * @returns {string[]}
     */
    get ips() {
        const trust = this.app._hot().trustProxyFn;
        if (!trust) {
            return [];
        }
        const addrs = proxyaddr.all(asMessage(this), trust);
        addrs.reverse().pop();
        return addrs;
    }

    /**
     * "http" or "https", from X-Forwarded-Proto behind a trusted proxy.
     * @returns {string}
     */
    get protocol() {
        // express reads socket.encrypted, which middleware assigns to; the app's ssl flag answers
        // while no stand-in was built
        const conn = this.#cachedConnection;
        const proto = (conn ? conn.encrypted : this.app.ssl) ? "https" : "http";
        const trust = this.app._hot().trustProxyFn;
        if (!trust) {
            return proto;
        }
        if (!trust(this.parsedIp, 0)) {
            return proto;
        }
        const header = /** @type {string|undefined} */ (this.headers["x-forwarded-proto"]) || proto;
        const index = header.indexOf(",");

        return index !== -1 ? header.slice(0, index).trim() : header.trim();
    }

    /**
     * The path of the current url, no query, relative to the mount; recomputed from req.url on
     * every read as express does, see currentPath.
     *
     * @returns {string}
     */
    get path() {
        return currentPath(this);
    }

    /**
     * Takes over what a middleware assigned to req.url, relative to the current mount as in
     * express: routing matches the new path and req.query the new query.
     *
     * @param {boolean} [leavingMount] the caller is popping the mount the rewrite happened in
     */
    _absorbUrlRewrite(leavingMount) {
        const assignedUrl = String(this.url);
        let newUrl = assignedUrl;
        const lastQueryIndex = this._lastUrl.indexOf("?");
        const oldPath = lastQueryIndex === -1 ? this._lastUrl : this._lastUrl.slice(0, lastQueryIndex);
        let prefix;
        if (oldPath === "/" && !this._originalPath.endsWith("/")) {
            prefix = this._originalPath;
            // express's slashAdded restore on the way out of a mount that consumed the whole path:
            // the "/" was invented, and the rejoin strips the first assigned character
            if (leavingMount === true) {
                newUrl = newUrl.slice(1);
            }
        } else {
            prefix = this._originalPath.slice(0, this._originalPath.length - oldPath.length);
        }
        const queryIndex = newUrl.indexOf("?");
        const newPath = queryIndex === -1 ? newUrl : newUrl.slice(0, queryIndex);
        this._rawQuery = queryIndex === -1 ? "" : newUrl.slice(queryIndex + 1);
        // a rewrite to "/a?" keeps its "?", as one arriving that way does
        this.urlQuery = queryIndex === -1 ? "" : "?" + this._rawQuery;
        this._originalPath = prefix + newPath;
        this._path = newPath;
        this.endsWithSlash = newPath.charCodeAt(newPath.length - 1) === 0x2f;
        this._opPath = newPath;
        this._opPathLower = null;
        this._mayFailDecode = null;
        // the assigned string, or the next hop absorbs the same rewrite again
        this._lastUrl = assignedUrl;
    }

    /**
     * Takes over what a middleware assigned to req.method: the two flags the routing scan reads,
     * and the verb set an OPTIONS needs.
     */
    _absorbMethodRewrite() {
        const method = this.method;
        this._isOptions = method === "OPTIONS";
        this._isHead = method === "HEAD";
        if (this._isOptions && this._matchedMethods === null) {
            this._matchedMethods = new Set();
        }
        this._lastMethod = method;
    }

    /**
     * Parsed by the "query parser" setting into a null-prototype object, a new one on every read as
     * express re-parses on every read: a sanitiser writing into req.query (express-validator's
     * trim) must not be seen by the next reader. Not parse-once-then-copy: the copy between
     * null-prototype objects measured 638ns against 119ns for the parse, -8% on the arena. The
     * default parser replays its decoded pairs instead. No setter, so assigning throws as on express.
     *
     * @returns {Record<string, any>}
     */
    get query() {
        const qp = this.app._hot().queryParserFn;
        // the vendored default already answers on a bare null prototype, any other parser is copied
        // onto one. A parser of the application's own gets what express hands it, parseurl's query:
        // null with no "?", the text after it otherwise, "" included
        if (!qp) {
            return Object.create(null);
        }
        if (qp === parseQuery) {
            const raw = this._rawQuery;
            if (this._querySnapRaw === raw) {
                const snap = this._querySnap;
                if (snap === false) {
                    return parseQuery(raw);
                }
                const out = Object.create(null);
                const pairs = /** @type {string[]} */ (snap);
                for (let i = 0, len = pairs.length; i < len; i += 2) {
                    out[pairs[i]] = pairs[i + 1];
                }
                return out;
            }
            /** @type {string[] & {invalid?: boolean}} */
            const capture = [];
            const out = parseQuery(raw, capture);
            this._querySnapRaw = raw;
            this._querySnap = capture.invalid === true ? false : capture;
            return out;
        }
        // the other parsers keep no snapshot, only the mark that a parse happened
        this._querySnapRaw = this._rawQuery;
        this._querySnap = false;
        if (qp === fastQueryParse) {
            return Object.assign(Object.create(null), fastQueryParse(this._rawQuery));
        }
        return Object.assign(Object.create(null), qp(this.urlQuery === "" ? null : this._rawQuery));
    }

    /**
     * Whether the request came in over TLS.
     * @returns {boolean}
     */
    get secure() {
        return this.protocol === "https";
    }

    /**
     * The subdomains, furthest from the root first, minus "subdomain offset" labels. An IP is one label.
     * @returns {string[]}
     */
    get subdomains() {
        if (this.#cachedSubdomains !== null) {
            return this.#cachedSubdomains;
        }

        const hostname = this.hostname;
        if (!hostname) {
            return (this.#cachedSubdomains = []);
        }

        const offset = this.app.get("subdomain offset");
        const parts = isIP(hostname) ? [hostname] : hostname.split(".").reverse();

        return (this.#cachedSubdomains = parts.slice(offset));
    }

    /**
     * Whether X-Requested-With says XMLHttpRequest.
     * @returns {boolean}
     */
    get xhr() {
        const val = this.headers?.["x-requested-with"];
        return typeof val === "string" && val.toLowerCase() === "xmlhttprequest";
    }

    /**
     * The peer address bytes, from the socket or from a PROXY protocol preamble when the setting
     * is on. Off by default and it has to stay so: uWS parses the preamble from anyone, so any
     * client could claim any address to a rate limiter. Turn it on only behind the proxy.
     *
     * @returns {ArrayBuffer} the socket's own address when no preamble arrived
     */
    _readRawIp() {
        const uwsRes = this._res;
        if (this.app._hot().trustProxyProtocol) {
            const proxied = uwsRes.getProxiedRemoteAddress();
            // empty unless a preamble arrived
            if (proxied.byteLength !== 0) {
                return proxied;
            }
        }
        return uwsRes.getRemoteAddress();
    }

    /**
     * The peer address as text, cached. An app asking after the response is over gets 127.0.0.1
     * once and the real address from the next request on, see the constructor.
     *
     * @returns {string|undefined} undefined over a unix socket, which has no address
     */
    get parsedIp() {
        if (this.#cachedParsedIp !== null) {
            return this.#cachedParsedIp;
        }
        const finished = this.res.finished;
        if (finished) {
            this.app.needsIpAfterResponse = true;
        }
        if (!this.rawIp) {
            if (finished) {
                return mapsIPv4Peer(this.app) ? "::ffff:127.0.0.1" : "127.0.0.1";
            }
            this.rawIp = this._readRawIp();
        }
        const rawIp = /** @type {ArrayBuffer} */ (this.rawIp);
        /** @type {string|undefined} */
        let ip;
        if (rawIp.byteLength === 4) {
            // plain, as node writes an IPv4 peer on an IPv4 socket
            ip = new Uint8Array(rawIp).join(".");
        } else if (rawIp.byteLength === 16) {
            const bytes = new Uint8Array(rawIp);
            if (isMappedIPv4(bytes)) {
                // ::ffff:a.b.c.d, nearly every request on a dual stack listener: the general
                // path below costs 157ns more
                ip = "::ffff:" + bytes[12] + "." + bytes[13] + "." + bytes[14] + "." + bytes[15];
            } else {
                const dv = new DataView(rawIp);
                const groups = new Array(8);
                for (let i = 0; i < 8; i++) {
                    groups[i] = dv.getUint16(i * 2);
                }
                ip = formatIPv6(groups);
            }
        } else {
            ip = undefined; // a unix socket has no address
        }
        this.#cachedParsedIp = ip;
        return ip;
    }

    /**
     * The socket stand-in, the same object as `res.socket`, kept here so it still answers once
     * the response is over and `res.socket` is null.
     * @returns {import("./socket.js")}
     */
    get connection() {
        return (this.#cachedConnection ??= this.res._socketShim());
    }

    /** node's other name for `connection`. */
    get socket() {
        return this.connection;
    }

    /**
     * Cuts this request loose from its uWS response, for a websocket upgrade where the request
     * outlives it: the peer address is read while the response is alive, an inert stand-in
     * answers later.
     */
    _detachFromResponse() {
        const uwsRes = this._res;
        if (!this.rawIp) {
            this.rawIp = this._readRawIp();
        }
        const remotePort = uwsRes.getRemotePort();
        const rawIp = this.rawIp;
        this._res = /** @type {import("uWebSockets.js").HttpResponse} */ (
            /** @type {unknown} */ ({
                getRemoteAddress: () => rawIp,
                getProxiedRemoteAddress: () => emptyAddress,
                getRemotePort: () => remotePort,
                onData() {},
                pause() {},
                resume() {},
                close() {}
            })
        );
    }

    /**
     * Whether the client's cached copy is still good, from If-None-Match and If-Modified-Since
     * against the response headers set so far. Only GET and HEAD can be fresh.
     * @returns {boolean}
     */
    get fresh() {
        if (this.method !== "HEAD" && this.method !== "GET") {
            return false;
        }
        if ((this.res.statusCode >= 200 && this.res.statusCode < 300) || this.res.statusCode === 304) {
            // send() asks on every response: without a conditional header the answer is no, read
            // off the raw entries instead of building the headers object
            if (this.#cachedHeaders === null) {
                let hasConditional = false;
                const entries = this.#rawHeadersEntries;
                for (let i = 0, len = entries.length; i < len; i += 2) {
                    const key = entries[i];
                    if (key.length === 13 || key.length === 17) {
                        if (key === "if-none-match" || key === "if-modified-since") {
                            hasConditional = true;
                            break;
                        }
                    }
                }
                if (!hasConditional) {
                    return false;
                }
            }
            return fresh(this.headers, {
                etag: this.res.headers["etag"],
                "last-modified": this.res.headers["last-modified"]
            });
        }
        return false;
    }

    /**
     * The opposite of `fresh`.
     * @returns {boolean}
     */
    get stale() {
        return !this.fresh;
    }

    /**
     * Reads a request header, case insensitively; "referer" and "referrer" both work.
     *
     * @param {string} field header name
     * @returns {string|string[]|undefined}
     * @throws {TypeError} if field is missing or is not a string
     */
    get(field) {
        if (!field) {
            throw new TypeError("name argument is required to req.get");
        }
        if (typeof field !== "string") {
            throw new TypeError("name must be a string to req.get");
        }
        field = field.toLowerCase();
        if (field === "referrer" || field === "referer") {
            const res = this.headers["referrer"];
            if (!res) {
                return this.headers["referer"];
            }
            return res;
        }
        return this.headers[field];
    }

    /**
     * Picks the best of the given types against the Accept header.
     * @param {...(string|string[])} types extensions or mime types
     * @returns {string|string[]|false} the best match, false if none is acceptable, or every
     *   acceptable type when called with no arguments
     */
    accepts(...types) {
        return accepts(asMessage(this)).types(.../** @type {string[]} */ (types));
    }

    /**
     * The same, against Accept-Charset.
     * @param {...(string|string[])} charsets
     * @returns {string|string[]|false}
     */
    acceptsCharsets(...charsets) {
        return accepts(asMessage(this)).charsets(.../** @type {string[]} */ (charsets));
    }

    /**
     * The same, against Accept-Encoding.
     * @param {...(string|string[])} encodings
     * @returns {string|string[]|false}
     */
    acceptsEncodings(...encodings) {
        return accepts(asMessage(this)).encodings(.../** @type {string[]} */ (encodings));
    }

    /**
     * The same, against Accept-Language.
     * @param {...(string|string[])} languages
     * @returns {string|string[]|false}
     */
    acceptsLanguages(...languages) {
        return accepts(asMessage(this)).languages(.../** @type {string[]} */ (languages));
    }

    /**
     * @deprecated the singular spelling Express 4 carried; use acceptsEncodings
     * @param {...(string|string[])} args
     * @returns {string|string[]|false}
     */
    acceptsEncoding(...args) {
        deprecated("req.acceptsEncoding", "req.acceptsEncodings");
        return this.acceptsEncodings(...args);
    }

    /**
     * @deprecated the singular spelling Express 4 carried; use acceptsCharsets
     * @param {...(string|string[])} args
     * @returns {string|string[]|false}
     */
    acceptsCharset(...args) {
        deprecated("req.acceptsCharset", "req.acceptsCharsets");
        return this.acceptsCharsets(...args);
    }

    /**
     * @deprecated the singular spelling Express 4 carried; use acceptsLanguages
     * @param {...(string|string[])} args
     * @returns {string|string[]|false}
     */
    acceptsLanguage(...args) {
        deprecated("req.acceptsLanguage", "req.acceptsLanguages");
        return this.acceptsLanguages(...args);
    }

    /**
     * Whether the request body's Content-Type matches. Accepts extensions ("json"), mime types
     * ("application/json") and wildcards ("application/*").
     *
     * @param {string|string[]} types one or several, as an array or as separate arguments
     * @returns {string|false|null} the matching type, false if it does not match, null if there
     *   is no body to have a type
     */
    is(types) {
        if (Array.isArray(types)) {
            return typeis(asMessage(this), types);
        }

        if (arguments.length === 1) {
            return typeis(asMessage(this), [types]);
        }

        return typeis(asMessage(this), [...arguments]);
    }

    /**
     * Parses the Range header against a resource of the given size.
     *
     * @param {number} size length of the resource being served
     * @param {{combine?: boolean}} [options] combine adjacent and overlapping ranges
     * @returns {Array|number|undefined} the ranges, -1 when unsatisfiable, -2 when malformed,
     *   or undefined when there is no Range header
     */
    range(size, options) {
        const range = this.headers["range"];
        if (!range) return;
        return parseRange(size, range, options);
    }

    /** Middleware does assign to it, and Express lets it. */
    set headers(headers) {
        this.#cachedHeaders = headers;
    }

    /**
     * The headers as node presents them, repeats folded node's way: Set-Cookie an array, Cookie
     * joined with "; ", discardedDuplicates first value only, the rest ", ". Built on first read.
     *
     * @returns {import("http").IncomingHttpHeaders}
     */
    get headers() {
        if (this.#cachedHeaders) {
            return this.#cachedHeaders;
        }
        // a plain object as node's, so Object.hasOwn keeps a header named "constructor" from
        // folding into Object.prototype's member
        /** @type {import("http").IncomingHttpHeaders} */
        const headers = {};
        const entries = this.#rawHeadersEntries;
        for (let index = 0, len = entries.length; index < len; index += 2) {
            const value = entries[index + 1];
            const key = entries[index];
            if (headers[key] !== undefined && Object.hasOwn(headers, key)) {
                if (discardedDuplicates.has(key)) {
                    continue;
                }
                if (key === "cookie") {
                    headers[key] += "; " + value;
                } else if (key === "set-cookie") {
                    /** @type {string[]} */ (headers[key]).push(value);
                } else {
                    headers[key] += ", " + value;
                }
                continue;
            }
            if (key === "set-cookie") {
                headers[key] = [value];
            } else {
                headers[key] = value;
            }
        }
        this.#cachedHeaders = headers;
        return headers;
    }

    /**
     * node's headersDistinct: every repeat kept, each name an array.
     *
     * @returns {Record<string, string[]>}
     */
    get headersDistinct() {
        if (this.#cachedDistinctHeaders) {
            return this.#cachedDistinctHeaders;
        }
        const distinct = /** @type {Record<string, string[]>} */ (Object.create(null));
        const entries = this.#rawHeadersEntries;
        for (let index = 0, len = entries.length; index < len; index += 2) {
            const key = entries[index];
            const value = entries[index + 1];
            if (distinct[key] === undefined) {
                distinct[key] = [value];
            } else {
                distinct[key].push(value);
            }
        }
        this.#cachedDistinctHeaders = distinct;
        return distinct;
    }

    /**
     * node's rawHeaders, a flat list of name then value in arrival order.
     * @returns {string[]}
     */
    get rawHeaders() {
        // a copy: the array itself is what routing reads
        return this.#rawHeadersEntries.slice();
    }

    /**
     * Whether the folded `req.headers` object was built, which src/work.js reports.
     * @returns {boolean}
     */
    get _headersBuilt() {
        return this.#cachedHeaders !== null || this.#cachedDistinctHeaders !== null;
    }

    /**
     * Whether the query string was parsed at least once, which src/work.js reports.
     * @returns {boolean}
     */
    get _queryParsed() {
        return this._querySnapRaw !== undefined;
    }

    /**
     * Whether the socket stand-in `req.connection` was allocated, which src/work.js reports.
     * @returns {boolean}
     */
    get _socketBuilt() {
        return Boolean(this.#cachedConnection);
    }
};

// Express's other name for req.get, on the prototype so no own property is written per request
/** @type {{header?: typeof module.exports.prototype.get}} */ (module.exports.prototype).header =
    module.exports.prototype.get;
