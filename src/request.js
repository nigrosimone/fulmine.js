/*
Copyright 2024 dimden.dev

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

const { patternToRegex, deprecated, NullObject } = require("./utils.js");
const accepts = require("accepts");
const typeis = require("type-is");
const parseRange = require("range-parser");
const proxyaddr = require("proxy-addr");
const { isIP } = require("node:net");
const fresh = require("fresh");
const { Readable } = require("stream");

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

module.exports = class Request extends Readable {
    #cachedQuery = null;
    #cachedHeaders = null;
    #cachedDistinctHeaders = null;
    #rawHeadersEntries = [];
    #cachedParsedIp = null;
    #paused = false;
    body;
    res;
    optimizedParams;
    _error;
    noEtag;
    constructor(req, res, app) {
        super({ highWaterMark: 128 * 1024 });
        this._res = res;
        this._req = req;
        this.readable = true;
        this._req.forEach((key, value) => {
            this.#rawHeadersEntries.push([key, value]);
        });
        this.routeCount = 1;
        this.key = key++;
        if (key > 100000) {
            key = 0;
        }
        this.app = app;
        this.urlQuery = req.getQuery() ?? "";
        if (this.urlQuery) {
            this.urlQuery = "?" + this.urlQuery;
        }
        this.originalUrl = req.getUrl() + this.urlQuery;
        this.url = this.originalUrl;
        const iq = this.url.indexOf("?");
        this.path = iq !== -1 ? this.url.substring(0, iq) : this.url;
        this.endsWithSlash = this.path[this.path.length - 1] === "/";
        this._opPath = this.path;
        this._originalPath = this.path;
        if (this.endsWithSlash && this.path !== "/" && !this.app.get("strict routing")) {
            this._opPath = this._opPath.slice(0, -1);
        }
        this.method = req.getCaseSensitiveMethod().toUpperCase();
        this._isOptions = this.method === "OPTIONS";
        this._isHead = this.method === "HEAD";
        this.params = {};

        this._matchedMethods = new Set();
        this._gotParams = new Set();
        this._stack = [];
        // number of entries in _stack that aren't the empty path. while this is 0 the whole
        // stack joins to "", so getFullMountpath can skip the join entirely
        this._stackMounted = 0;
        this._paramStack = [];
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
            (additionalMethods && additionalMethods.includes(this.method))
        ) {
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
        } else {
            this.receivedData = true;
            this.push(null);
        }
    }

    get #responseEnded() {
        return this.res?.finished || this.res?.aborted;
    }

    _read() {
        if (this.#paused && !this.#responseEnded) {
            this.#paused = false;
            this._res.resume();
        }
    }

    get baseUrl() {
        const match = this._originalPath.match(patternToRegex(this._stack.join(""), true));
        return match ? match[0] : "";
    }

    set baseUrl(x) {
        this._originalPath = x;
    }

    // the Host header as sent, trimmed and resolved through trust proxy, port still attached
    get #authority() {
        const trust = this.app.get("trust proxy fn");
        const isTrusted = !!(trust && trust(this.connection.remoteAddress, 0));
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

    get httpVersion() {
        return "1.1";
    }

    get httpVersionMajor() {
        return 1;
    }

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
        return proxyaddr(this, trust);
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
        const addrs = proxyaddr.all(this, trust);
        addrs.reverse().pop();
        return addrs;
    }

    /**
     * "http" or "https", taken from X-Forwarded-Proto when the connection comes from a
     * trusted proxy.
     * @returns {string}
     */
    get protocol() {
        const proto = this.app.ssl ? "https" : "http";
        const trust = this.app.get("trust proxy fn");
        if (!trust) {
            return proto;
        }
        if (!trust(this.connection.remoteAddress, 0)) {
            return proto;
        }
        const header = this.headers["x-forwarded-proto"] || proto;
        const index = header.indexOf(",");

        return index !== -1 ? header.slice(0, index).trim() : header.trim();
    }

    /**
     * The parsed query string, on a null-prototype object so a query cannot reach
     * Object.prototype keys. Parsed once and cached.
     *
     * There is deliberately no setter, so assigning to req.query throws in strict mode, exactly
     * as it does on Express.
     *
     * @returns {object}
     */
    // a getter with no setter at all, so assigning to req.query throws in strict mode. Middleware
    // that rewrites the query, express-mongo-sanitize being the common one, fails here exactly as
    // it fails on Express, which is the point of not adding a setter.
    // The parser's result is returned as-is: spreading it would drop the null prototype that keeps
    // a query string away from Object.prototype keys.
    get query() {
        if (this.#cachedQuery) {
            return this.#cachedQuery;
        }
        const qp = this.app.get("query parser fn");
        // normalised onto a plain null-prototype object: fast-querystring returns instances of an
        // internal class called Empty, which node inspects as "Empty <[Object: null prototype] {}>"
        // where Express shows "[Object: null prototype]"
        this.#cachedQuery = qp ? Object.assign({ __proto__: null }, qp(this.urlQuery.slice(1))) : { __proto__: null };
        return this.#cachedQuery;
    }

    /**
     * Whether the request came in over TLS.
     * @returns {boolean}
     */
    get secure() {
        return this.protocol === "https";
    }

    #cachedSubdomains = null;

    /**
     * The hostname's subdomains, furthest from the root first, dropping the last
     * "subdomain offset" labels. Empty for an IP address.
     * @returns {string[]}
     */
    get subdomains() {
        if (this.#cachedSubdomains !== null) {
            return this.#cachedSubdomains;
        }

        const hostname = this.hostname;
        if (!hostname || isIP(hostname)) {
            return (this.#cachedSubdomains = []);
        }

        const offset = this.app.get("subdomain offset");
        const parts = hostname.split(".");
        const subdomains = parts.reverse().slice(offset);

        return (this.#cachedSubdomains = subdomains);
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
                return "127.0.0.1";
            }
            this.rawIp = this._res.getRemoteAddress();
        }
        let ip = "";
        if (this.rawIp.byteLength === 4) {
            // ipv4
            ip = new Uint8Array(this.rawIp).join(".");
        } else if (this.rawIp.byteLength === 16) {
            // ipv6
            const dv = new DataView(this.rawIp);
            for (let i = 0; i < 8; i++) {
                ip += dv
                    .getUint16(i * 2)
                    .toString(16)
                    .padStart(4, "0");
                if (i < 7) {
                    ip += ":";
                }
            }
        } else {
            ip = undefined; // unix sockets dont have ip
        }
        this.#cachedParsedIp = ip;
        return ip;
    }

    get connection() {
        return {
            remoteAddress: this.parsedIp,
            remotePort: this._res.getRemotePort(),
            localPort: this.app.port,
            encrypted: this.app.ssl,
            end: (body) => this.res.end(body)
        };
    }

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
            // fast path: res.end() reads req.fresh on every response, but fresh() can only
            // return true when the request carries a conditional header. Scan the raw entries
            // instead of materializing the full headers object, which is lazy by design.
            // Only valid while headers are untouched: both the getter and the setter populate #cachedHeaders.
            if (this.#cachedHeaders === null) {
                let hasConditional = false;
                const entries = this.#rawHeadersEntries;
                for (let i = 0, len = entries.length; i < len; i++) {
                    const key = entries[i][0];
                    // 'if-none-match'.length === 13, 'if-modified-since'.length === 17
                    if (key.length === 13 || key.length === 17) {
                        const lower = key.toLowerCase();
                        if (lower === "if-none-match" || lower === "if-modified-since") {
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
    header = this.get;

    /**
     * Picks the best of the given types against the Accept header.
     * @param {...(string|string[])} types extensions or mime types
     * @returns {string|string[]|false} the best match, false if none is acceptable, or every
     *   acceptable type when called with no arguments
     */
    accepts(...types) {
        return accepts(this).types(...types);
    }

    /**
     * The same, against Accept-Charset.
     * @param {...(string|string[])} charsets
     * @returns {string|string[]|false}
     */
    acceptsCharsets(...charsets) {
        return accepts(this).charsets(...charsets);
    }

    /**
     * The same, against Accept-Encoding.
     * @param {...(string|string[])} encodings
     * @returns {string|string[]|false}
     */
    acceptsEncodings(...encodings) {
        return accepts(this).encodings(...encodings);
    }

    /**
     * The same, against Accept-Language.
     * @param {...(string|string[])} languages
     * @returns {string|string[]|false}
     */
    acceptsLanguages(...languages) {
        return accepts(this).languages(...languages);
    }

    acceptsEncoding(...args) {
        deprecated("req.acceptsEncoding", "req.acceptsEncodings");
        return this.acceptsEncodings(...args);
    }

    acceptsCharset(...args) {
        deprecated("req.acceptsCharset", "req.acceptsCharsets");
        return this.acceptsCharsets(...args);
    }

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
            return typeis(this, types);
        }

        if (arguments.length === 1) {
            return typeis(this, [types]);
        }

        return typeis(this, [...arguments]);
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

    set headers(headers) {
        this.#cachedHeaders = headers;
    }
    get headers() {
        // https://nodejs.org/api/http.html#messageheaders
        if (this.#cachedHeaders) {
            return this.#cachedHeaders;
        }
        this.#cachedHeaders = { ...new NullObject() }; // seems to be faster
        for (let index = 0, len = this.#rawHeadersEntries.length; index < len; index++) {
            let [key, value] = this.#rawHeadersEntries[index];
            key = key.toLowerCase();
            if (this.#cachedHeaders[key]) {
                if (discardedDuplicates.has(key)) {
                    continue;
                }
                if (key === "cookie") {
                    this.#cachedHeaders[key] += "; " + value;
                } else if (key === "set-cookie") {
                    this.#cachedHeaders[key].push(value);
                } else {
                    this.#cachedHeaders[key] += ", " + value;
                }
                continue;
            }
            if (key === "set-cookie") {
                this.#cachedHeaders[key] = [value];
            } else {
                this.#cachedHeaders[key] = value;
            }
        }
        return this.#cachedHeaders;
    }

    get headersDistinct() {
        if (this.#cachedDistinctHeaders) {
            return this.#cachedDistinctHeaders;
        }
        this.#cachedDistinctHeaders = { ...new NullObject() };
        this.#rawHeadersEntries.forEach((val) => {
            const [key, value] = val;
            if (!this.#cachedDistinctHeaders[key]) {
                this.#cachedDistinctHeaders[key] = [value];
                return;
            }
            this.#cachedDistinctHeaders[key].push(value);
        });
        return this.#cachedDistinctHeaders;
    }

    get rawHeaders() {
        const res = [];
        for (let index = 0, len = this.#rawHeadersEntries.length; index < len; index++) {
            const val = this.#rawHeadersEntries[index];
            res.push(val[0], val[1]);
        }
        return res;
    }
};
