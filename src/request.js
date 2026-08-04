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

const { deprecated } = require("./utils.js");
const accepts = require("accepts");
const typeis = require("type-is");
const parseRange = require("range-parser");
const proxyaddr = require("proxy-addr");
const { isIP } = require("node:net");
const fresh = require("fresh");
const { Readable } = require("stream");

// accepts, type-is, proxy-addr and fresh all declare a node IncomingMessage and read nothing off
// it but .headers. This request is deliberately not one, so it is handed over as itself and the
// declared shape is stepped around at each call.
const asMessage = (req) => /** @type {any} */ (req);

/**
 * Writes an address the way node writes socket.remoteAddress, which is inet_ntop's output and so
 * RFC 5952: leading zeros dropped from each group, the longest run of two or more zero groups
 * written as "::", and the last four bytes written in dotted form for the addresses that carry an
 * IPv4 one. uWS hands over the sixteen bytes, and writing them out in full gave req.ip
 * "0000:0000:0000:0000:0000:0000:0000:0001" where Express says "::1".
 *
 * @param {number[]} groups the eight 16-bit groups, most significant first
 * @returns {string}
 */
function formatIPv6(groups) {
    // longest run of zero groups, leftmost on a tie, which is the run inet_ntop replaces
    let bestStart = -1;
    let bestLength = 0;
    for (let i = 0; i < 8; i++) {
        if (groups[i] !== 0) continue;
        let run = 1;
        while (i + run < 8 && groups[i + run] === 0) run++;
        if (run > bestLength) {
            bestStart = i;
            bestLength = run;
        }
        i += run - 1;
    }
    // a single zero group is written as "0", not as "::"
    if (bestLength < 2) {
        bestStart = -1;
        bestLength = 0;
    }

    // ::ffff:a.b.c.d, and the deprecated ::a.b.c.d. The test is inet_ntop's own, including that a
    // run of seven leading zeros never reaches it, since group 6 is inside the run by then.
    const mixed =
        bestStart === 0 &&
        (bestLength === 6 || (bestLength === 7 && groups[7] !== 1) || (bestLength === 5 && groups[5] === 0xffff));

    let out = "";
    for (let i = 0; i < 8; i++) {
        if (bestStart !== -1 && i >= bestStart && i < bestStart + bestLength) {
            if (i === bestStart) out += ":";
            continue;
        }
        if (i !== 0) out += ":";
        if (mixed && i === 6) {
            out += `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
            break;
        }
        out += groups[i].toString(16);
    }
    // a run reaching the end leaves a trailing group to close the "::"
    if (bestStart !== -1 && bestStart + bestLength === 8) out += ":";
    return out;
}

/**
 * Whether node would report an IPv4 peer of this app in mapped form, "::ffff:a.b.c.d". Node maps
 * it whenever the listener is dual stack, which is every listen() not given an IPv4 address to
 * bind. uWS already hands mapped peers over as sixteen bytes; four bytes only reach req.ip from a
 * v4-bound native listener or through the node shim, whose server supertest binds dual stack.
 *
 * @param {any} app the application the request arrived at
 * @returns {boolean}
 */
function mapsIPv4Peer(app) {
    const host = app._listenHost;
    return !(host && isIP(host) === 4);
}

const discardedDuplicates = new Set([
    "age",
    "authorization",
    "content-length",
    "content-type",
    "etag",
    "expires",
    "from",
    "host",
    "if-modified-since",
    "if-unmodified-since",
    "last-modified",
    "location",
    "max-forwards",
    "proxy-authorization",
    "referer",
    "retry-after",
    "server",
    "user-agent"
]);

let key = 0;

// 128 KB of body buffered before uWS is asked to pause
const READABLE_OPTIONS = { highWaterMark: 128 * 1024 };

// Whose headers the shared collector below is filling. uWS's forEach is synchronous and runs no
// user code, so the handoff cannot interleave; module-level so the callback exists once instead
// of once per request.
let currentRequest = null;

module.exports = class Request extends Readable {
    /** @type {Record<string, any>|null} */
    #cachedQuery = null;

    /** @type {Record<string, any>|null} */
    #cachedHeaders = null;

    /** @type {Record<string, string[]>|null} */
    #cachedDistinctHeaders = null;

    // Flat, name then value: an array of pairs meant one array allocated per header on every
    // request, and a request carries eight or ten of them. Everything that reads this walks it two
    // at a time. The names are lowercase by contract: uWS lowers them on the wire and the node
    // shim lowers them in its forEach, so readers compare without lowering again.
    #rawHeadersEntries = [];

    /** @type {string|undefined|null} */
    #cachedParsedIp = null;

    #paused = false;

    // a bodyless request whose empty end has not been delivered yet, see the constructor
    #emptyBody = false;

    body;

    res;

    // one function for every request, fed through currentRequest: an arrow in the constructor
    // captured `this`, which cost a context and a function allocation per request
    static #collectHeader = (headerKey, value) => {
        const r = currentRequest;
        r.#rawHeadersEntries.push(headerKey, value);
        // spotted in the loop that is running anyway: a client asking for the connection to be
        // closed must not be answered that it is being kept alive. The response is built right
        // after this and reads the flag.
        if (
            headerKey.length === 10 &&
            headerKey === "connection" &&
            value.length === 5 &&
            value.toLowerCase() === "close"
        ) {
            r._connectionClose = true;
        } else if (
            (headerKey.length === 14 && headerKey === "content-length") ||
            (headerKey.length === 17 && headerKey === "transfer-encoding")
        ) {
            // noticed here so the body decision in the constructor does not build the headers object
            r._declaresBody = true;
        }
    };

    optimizedParams;

    _error;

    noEtag;

    /**
     * Built for every request, which is why so little happens here. The headers are copied out
     * because uWS only lends them for this call, everything derived from them waits until something
     * asks, and the body is subscribed to only for the methods that carry one.
     *
     * @param {any} req the uWS request, readable only during this call
     * @param {any} res the uWS response
     * @param {any} app the application or router this request arrived at
     */
    constructor(req, res, app) {
        // the same object every time: Readable reads these options and never writes to them
        super(READABLE_OPTIONS);
        this._res = res;
        this._req = req;
        this.readable = true;
        currentRequest = this;
        this._req.forEach(Request.#collectHeader);
        currentRequest = null;
        this.routeCount = 1;
        this.key = key++;
        if (key > 100000) {
            key = 0;
        }
        this.app = app;
        // both forms are kept, because both are asked for: the query with its "?" goes into
        // req.url, and req.query parses the raw one. Keeping only the first meant slicing the "?"
        // back off for every request that reads req.query.
        this._rawQuery = req.getQuery() ?? "";
        this.urlQuery = this._rawQuery === "" ? "" : "?" + this._rawQuery;
        // getUrl() is the path already, so the query is joined on and then not split off again.
        // Building originalUrl and picking the path back out of it with indexOf and substring was
        // a search and a second string for something uWS had just handed over.
        this.path = req.getUrl();
        this.originalUrl = this.path + this.urlQuery;
        this.url = this.originalUrl;
        // what the router last wrote to req.url. A middleware assigning something else is a
        // rewrite, which express honours, and dispatch compares against this to notice it
        this._lastUrl = this.originalUrl;
        // charCodeAt rather than indexing: s[i] builds a one character string to throw away
        this.endsWithSlash = this.path.charCodeAt(this.path.length - 1) === 0x2f;
        this._opPath = this.path;
        this._originalPath = this.path;
        if (this.endsWithSlash && this.path !== "/" && !this.app.get("strict routing")) {
            this._opPath = this._opPath.slice(0, -1);
        }
        this.method = req.getCaseSensitiveMethod().toUpperCase();
        this._isOptions = this.method === "OPTIONS";
        this._isHead = this.method === "HEAD";
        this.params = {};

        // Two Sets per request, for two things almost no request needs.
        //
        // _matchedMethods collects the verbs a path answers so an OPTIONS request can be told what
        // they are, and every place that reads it asks _isOptions first, so it is built only for
        // the requests that are one.
        //
        // _paramCalled remembers, per router, what each app.param() callback was called with and
        // what it left behind, so it is only wanted by an application that uses app.param at all.
        // The router builds it the first time it has something to put in it.
        this._matchedMethods = this._isOptions ? new Set() : null;
        this._paramCalled = null;
        // null for the same reason as the two above: a request that never enters a mount never
        // needs either array, and the push sites materialize them
        this._stack = null;
        // number of entries in _stack that aren't the empty path. while this is 0 the whole
        // stack joins to "", so getFullMountpath can skip the join entirely
        this._stackMounted = 0;
        this._paramStack = null;
        this.receivedData = false;
        // reading ip is very slow in UWS, so its better to not do it unless truly needed
        if (this.app.needsIpAfterResponse || this.key < 100) {
            // if app needs ip after response, read it now because after response its not accessible
            // also read it for first 100 requests to not error
            this.rawIp = this._res.getRemoteAddress();
        }

        const additionalMethods = this.app.get("body methods");
        // skip reading body for non-POST requests
        // this makes it +10k req/sec faster
        if (
            this.method === "POST" ||
            this.method === "PUT" ||
            this.method === "PATCH" ||
            this.method === "QUERY" ||
            (additionalMethods && additionalMethods.includes(this.method)) ||
            // any request that declares a body carries one, whatever the verb: a GET with
            // content-length left unread would end this stream empty and poison the keep-alive
            // connection with its unconsumed bytes. uWS itself discards GET bodies, so this is
            // the node shim's path
            /** @type {any} */ (this)._declaresBody
        ) {
            this._subscribeBody();
        } else {
            this.receivedData = true;
            // not pushed here: ending a Readable costs a scheduled tick and its bookkeeping,
            // and on a bodyless request nobody may ever look. The null goes out from _read(),
            // which is where every consumer arrives
            this.#emptyBody = true;
        }
    }

    /**
     * Subscribes to the uWS body stream. Out of the constructor so a bodyless request allocates
     * no closure at all there; must still run during the constructor call, since uWS only feeds a
     * handler registered before the route handler returns.
     */
    _subscribeBody() {
        this._res.onData((ab, isLast) => {
            this.receivedData = true;
            if (this.#responseEnded) {
                return;
            }
            // ab.slice(0) copies the ArrayBuffer; uWS neuters `ab` after this callback,
            // so a Buffer.from(ab) view would corrupt data left in the Readable queue.
            const chunk = Buffer.from(ab.slice(0));
            const accepted = this.push(chunk);
            // push() may synchronously end the response via a flowing-mode listener.
            if (!accepted && !isLast && !this.#responseEnded) {
                this._res.pause();
                this.#paused = true;
            }
            if (isLast) {
                this.push(null);
            }
        });
    }

    /**
     * Whether there is any point still reading the body: once the response is finished or the
     * connection is gone, uWS has nothing left to hand over.
     */
    get #responseEnded() {
        return this.res?.finished || this.res?.aborted;
    }

    /**
     * Readable's pull. uWS pushes the body rather than being pulled from, so all this does is
     * lift the backpressure that a full queue put on it.
     */
    _read() {
        // first, so a bodyless stream still ends for a consumer that arrives after the
        // response finished, which express allows
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
     * The part of the path the routers mounted so far have consumed, which is the empty string at
     * the top level. Matched rather than joined, because a mount path can be a pattern. The regex
     * comes from the router's mountpath cache, since the same mount chain is walked by every
     * request and compiling it per read was measurable.
     * @returns {string}
     */
    get baseUrl() {
        if (this._baseUrlOverride !== undefined) {
            return this._baseUrlOverride;
        }
        const match = this._originalPath.match(this.app.getFullMountpath(this));
        return match ? match[0] : "";
    }

    /**
     * Only here because a getter without a setter makes the property read-only, and middleware in
     * the wild does assign to it. Express keeps it writable too. Kept apart from _originalPath,
     * which routing matches against: assigning baseUrl must change what reads back, not what
     * later routes see.
     */
    set baseUrl(x) {
        this._baseUrlOverride = x;
    }

    /**
     * The Host header as sent, trimmed and resolved through trust proxy, port still attached.
     * X-Forwarded-Host wins when the peer is trusted, and only its first entry: the header is
     * meant to carry one value, but nothing stops a proxy from appending.
     */
    get #authority() {
        const trust = this.app.get("trust proxy fn");
        // parsedIp is what connection.remoteAddress carries, without building the socket stand-in
        const isTrusted = !!(trust && trust(this.parsedIp, 0));
        const rawHeader = (isTrusted && this.headers["x-forwarded-host"]) || this.headers["host"];
        let host = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

        if (typeof host !== "string" || !host) return;
        host = host.trim();

        if (isTrusted) {
            const commaIndex = host.indexOf(",");
            if (commaIndex !== -1) {
                // Note: X-Forwarded-Host is normally only ever a
                //       single value, but this is to be safe.
                host = host.substring(0, commaIndex).trimEnd();
            }
        }

        return host || undefined;
    }

    /** The authority with the port removed, taking care not to read an IPv6 literal's colons. */
    get #host() {
        const host = this.#authority;
        if (!host) return;

        const offset = host[0] === "[" ? host.indexOf("]") + 1 : 0;
        const portIndex = host.indexOf(":", offset);

        return portIndex !== -1 ? host.substring(0, portIndex) : host;
    }

    /**
     * The authority, port included, from Host or from X-Forwarded-Host behind a trusted proxy.
     * `hostname` is the same value without the port.
     * @returns {string}
     */
    get host() {
        return this.#authority;
    }

    /**
     * The host without the port.
     * @returns {string}
     */
    get hostname() {
        return this.#host;
    }

    /**
     * Always "1.1". uWS speaks HTTP/1.1 and, when built for it, HTTP/3, and reports neither
     * version through this API, so the value node code expects to find here is hardcoded.
     * @returns {string}
     */
    get httpVersion() {
        return "1.1";
    }

    /** @returns {number} the 1 of HTTP/1.1, for code that reads the parts separately */
    get httpVersionMajor() {
        return 1;
    }

    /** @returns {number} the second 1 of HTTP/1.1 */
    get httpVersionMinor() {
        return 1;
    }

    /**
     * The client address. With "trust proxy" set this is the first address in X-Forwarded-For
     * that the trust function accepts, otherwise it is the socket's own address.
     * @returns {string|undefined} undefined on a unix socket, which has no address
     */
    get ip() {
        const trust = this.app.get("trust proxy fn");
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
        const trust = this.app.get("trust proxy fn");
        if (!trust) {
            return [];
        }
        const addrs = proxyaddr.all(asMessage(this), trust);
        addrs.reverse().pop();
        return addrs;
    }

    /**
     * "http" or "https", taken from X-Forwarded-Proto when the connection comes from a
     * trusted proxy.
     * @returns {string}
     */
    get protocol() {
        // express reads socket.encrypted, and middleware does assign to the stand-in; the app's
        // own ssl flag answers when nothing has built the stand-in yet
        const conn = this.#cachedConnection;
        const proto = (conn ? conn.encrypted : this.app.ssl) ? "https" : "http";
        const trust = this.app.get("trust proxy fn");
        if (!trust) {
            return proto;
        }
        // parsedIp rather than connection.remoteAddress: same value, no socket stand-in built
        if (!trust(this.parsedIp, 0)) {
            return proto;
        }
        const header = this.headers["x-forwarded-proto"] || proto;
        const index = header.indexOf(",");

        return index !== -1 ? header.slice(0, index).trim() : header.trim();
    }

    /**
     * Takes over what a middleware assigned to req.url: the remaining routing matches the new
     * path, and req.query reflects the new query string. The assigned url is relative to the
     * mount the request is currently in, as it is in express, so the absolute path is rebuilt
     * from the piece the mounts had consumed.
     */
    _absorbUrlRewrite() {
        const newUrl = String(this.url);
        const queryIndex = newUrl.indexOf("?");
        const newPath = queryIndex === -1 ? newUrl : newUrl.slice(0, queryIndex);
        // the prefix the mounts consumed: everything of the absolute path the relative one was not
        const lastQueryIndex = this._lastUrl.indexOf("?");
        const oldPath = lastQueryIndex === -1 ? this._lastUrl : this._lastUrl.slice(0, lastQueryIndex);
        const prefix =
            oldPath === "/" && !this._originalPath.endsWith("/")
                ? this._originalPath
                : this._originalPath.slice(0, this._originalPath.length - oldPath.length);
        this._rawQuery = queryIndex === -1 ? "" : newUrl.slice(queryIndex + 1);
        this.urlQuery = this._rawQuery === "" ? "" : "?" + this._rawQuery;
        this.#cachedQuery = null;
        this._originalPath = prefix + newPath;
        this.path = newPath;
        this.endsWithSlash = newPath.charCodeAt(newPath.length - 1) === 0x2f;
        this._opPath =
            this.endsWithSlash && newPath !== "/" && !this.app.get("strict routing") ? newPath.slice(0, -1) : newPath;
        this._lastUrl = newUrl;
    }

    /**
     * The query string parsed by whichever parser the "query parser" setting names, cached for the
     * life of the request. A null-prototype object, so a key like "__proto__" cannot reach
     * Object.prototype. No setter, so assigning to req.query throws as it does on Express.
     *
     * @returns {Record<string, any>}
     */
    get query() {
        if (this.#cachedQuery) {
            return this.#cachedQuery;
        }
        const qp = this.app.get("query parser fn");
        // copied onto a plain null-prototype object, or node inspects fast-querystring's result as
        // "Empty <[Object: null prototype] {}>" where Express shows "[Object: null prototype]".
        // Object.create(null) and not { __proto__: null }: 318ns against 640
        const parsed = qp ? Object.assign(Object.create(null), qp(this._rawQuery)) : Object.create(null);
        this.#cachedQuery = parsed;
        return parsed;
    }

    /**
     * Whether the request came in over TLS.
     * @returns {boolean}
     */
    get secure() {
        return this.protocol === "https";
    }

    /** @type {string[]|null} */
    #cachedSubdomains = null;

    /**
     * The hostname's subdomains, furthest from the root first, dropping the last
     * "subdomain offset" labels. An IP host is one label, never split on its dots.
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
     * Whether X-Requested-With says XMLHttpRequest. Only libraries that set that header are
     * detected, which today is mostly jQuery and not fetch.
     * @returns {boolean}
     */
    get xhr() {
        const val = this.headers?.["x-requested-with"];
        return typeof val === "string" && val.toLowerCase() === "xmlhttprequest";
    }

    /**
     * The peer address as text, read from uWS and cached. Reading it is expensive and it is gone
     * once the response has finished, so it is read up front for the first hundred requests, and
     * for every request once an application has been seen asking too late. That app gets 127.0.0.1
     * once and the real address from the next request on.
     *
     * @returns {string|undefined} undefined over a unix socket, which has no address
     */
    get parsedIp() {
        if (this.#cachedParsedIp !== null) {
            return this.#cachedParsedIp;
        }
        const finished = this.res.finished;
        if (finished) {
            // mark app as one that needs ip after response
            this.app.needsIpAfterResponse = true;
        }
        if (!this.rawIp) {
            if (finished) {
                // fallback once
                return mapsIPv4Peer(this.app) ? "::ffff:127.0.0.1" : "127.0.0.1";
            }
            this.rawIp = this._res.getRemoteAddress();
        }
        /** @type {string|undefined} */
        let ip;
        if (this.rawIp.byteLength === 4) {
            // ipv4
            ip = new Uint8Array(this.rawIp).join(".");
            if (mapsIPv4Peer(this.app)) {
                ip = "::ffff:" + ip;
            }
        } else if (this.rawIp.byteLength === 16) {
            // ipv6
            const dv = new DataView(this.rawIp);
            const groups = new Array(8);
            for (let i = 0; i < 8; i++) {
                groups[i] = dv.getUint16(i * 2);
            }
            ip = formatIPv6(groups);
        } else {
            ip = undefined; // unix sockets dont have ip
        }
        this.#cachedParsedIp = ip;
        return ip;
    }

    /** @type {object|null} */
    #cachedConnection = null;

    /**
     * Enough of a node socket for the middleware that reaches for one. Built on first read and
     * kept, so req.socket keeps its identity across reads as node's does. remotePort hides behind
     * its own getter because it is a native uWS call almost no caller makes.
     * @returns {{remoteAddress: string|undefined, remotePort: number, localPort: number|undefined, encrypted: boolean, end: (body?: any) => void}}
     */
    get connection() {
        if (this.#cachedConnection) {
            return this.#cachedConnection;
        }
        const uwsRes = this._res;
        return (this.#cachedConnection = {
            remoteAddress: this.parsedIp,
            get remotePort() {
                return uwsRes.getRemotePort();
            },
            localPort: this.app.port,
            encrypted: this.app.ssl,
            end: (body) => this.res.end(body)
        });
    }

    /**
     * The same object `connection` builds. node carries both names and middleware reaches for
     * either one, so both are here.
     */
    get socket() {
        return this.connection;
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
            // fast path: res.send() reads req.fresh on every response it sends, but fresh() can
            // only return true when the request carries a conditional header. Scan the raw entries
            // instead of materializing the full headers object, which is lazy by design.
            // Only valid while headers are untouched: both the getter and the setter populate #cachedHeaders.
            if (this.#cachedHeaders === null) {
                let hasConditional = false;
                const entries = this.#rawHeadersEntries;
                for (let i = 0, len = entries.length; i < len; i += 2) {
                    const key = entries[i];
                    // 'if-none-match'.length === 13, 'if-modified-since'.length === 17; the
                    // entries carry lowercase names by contract, so this compares them as they are
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
     * Reads a request header, case insensitively. "referer" and "referrer" both work, whichever
     * one the client sent.
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
        return accepts(asMessage(this)).types(.../** @type {any} */ (types));
    }

    /**
     * The same, against Accept-Charset.
     * @param {...(string|string[])} charsets
     * @returns {string|string[]|false}
     */
    acceptsCharsets(...charsets) {
        return accepts(asMessage(this)).charsets(.../** @type {any} */ (charsets));
    }

    /**
     * The same, against Accept-Encoding.
     * @param {...(string|string[])} encodings
     * @returns {string|string[]|false}
     */
    acceptsEncodings(...encodings) {
        return accepts(asMessage(this)).encodings(.../** @type {any} */ (encodings));
    }

    /**
     * The same, against Accept-Language.
     * @param {...(string|string[])} languages
     * @returns {string|string[]|false}
     */
    acceptsLanguages(...languages) {
        return accepts(asMessage(this)).languages(.../** @type {any} */ (languages));
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

    /**
     * Only here so a getter does not make the property read-only. Middleware that rewrites the
     * request headers wholesale assigns to it, and Express lets it.
     */
    set headers(headers) {
        this.#cachedHeaders = headers;
    }

    /**
     * The request headers as node presents them: lowercased names, and repeats folded the way
     * node folds them. Set-Cookie stays an array, Cookie is joined with "; ", the fields listed in
     * discardedDuplicates keep only the first value, and everything else is joined with ", ".
     *
     * Built on first read and cached, since the raw entries are what routing works from and most
     * requests never ask for this at all.
     *
     * @returns {Record<string, any>}
     */
    get headers() {
        // https://nodejs.org/api/http.html#messageheaders
        if (this.#cachedHeaders) {
            return this.#cachedHeaders;
        }
        // built into a local and published at the end, so a throw partway through cannot leave a
        // half-filled object cached. A plain object because node's is one and inspect prints the
        // difference; Object.hasOwn keeps a header named "constructor" or "toString" from finding
        // Object.prototype's member and folding a first value into it.
        const headers = {};
        const entries = this.#rawHeadersEntries;
        for (let index = 0, len = entries.length; index < len; index += 2) {
            const value = entries[index + 1];
            // lowercase by the entries' contract, see the field declaration
            const key = entries[index];
            if (Object.hasOwn(headers, key)) {
                if (discardedDuplicates.has(key)) {
                    continue;
                }
                if (key === "cookie") {
                    headers[key] += "; " + value;
                } else if (key === "set-cookie") {
                    headers[key].push(value);
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
     * The same headers with every repeat kept, each name mapping to an array. node exposes this
     * alongside the folded form for the callers that need to tell one header sent twice from one
     * header carrying a comma.
     *
     * @returns {Record<string, string[]>}
     */
    get headersDistinct() {
        if (this.#cachedDistinctHeaders) {
            return this.#cachedDistinctHeaders;
        }
        // null prototype and undefined check for the same reason as `headers`: a header named
        // after an Object.prototype member must not collide with it
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
     * The headers as a flat list, name then value, in the order they arrived and with the case
     * they arrived in. Same shape as node.
     * @returns {string[]}
     */
    get rawHeaders() {
        // a copy, since this is exactly how the headers are kept and handing the array itself out
        // would let a caller rewrite what routing reads
        return this.#rawHeadersEntries.slice();
    }
};

// req.header is req.get under Express's other name. On the prototype rather than an instance
// field, which wrote one own property per request in the constructor.
/** @type {any} */ (module.exports.prototype).header = module.exports.prototype.get;
