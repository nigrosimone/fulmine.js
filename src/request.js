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
const { isIP } = require("node:net");
const fresh = require("fresh");
const parseQuery = require("./parse-query.js");
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
 * Whether these sixteen bytes are an IPv4-mapped address, ::ffff:0:0/96: ten zero bytes and then
 * 0xffff. Ten comparisons rather than a loop, because this runs on every address that is read and
 * the first mismatch answers immediately for a real IPv6 peer.
 *
 * @param {Uint8Array} bytes exactly sixteen of them
 * @returns {boolean}
 */
function isMappedIPv4(bytes) {
    return (
        bytes[10] === 0xff &&
        bytes[11] === 0xff &&
        bytes[0] === 0 &&
        bytes[1] === 0 &&
        bytes[2] === 0 &&
        bytes[3] === 0 &&
        bytes[4] === 0 &&
        bytes[5] === 0 &&
        bytes[6] === 0 &&
        bytes[7] === 0 &&
        bytes[8] === 0 &&
        bytes[9] === 0
    );
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

/** What µWS returns for a proxied address when no PROXY protocol preamble arrived. */
const emptyAddress = new ArrayBuffer(0);

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

// 128 KB of body buffered before uWS is asked to pause
const READABLE_OPTIONS = { highWaterMark: 128 * 1024 };

// The methods node's parser accepts, which is the set a request can arrive with behind Express and
// the set a route can be registered for here. µWS accepts any token, so without this a line like
// `{"a":1}GET /path HTTP/1.1` is a request to it, with `{"A":1}GET` as the method. See _mustRefuse.
const KNOWN_METHODS = new Set(require("http").METHODS);

/**
 * Whether a request target is bytes node's parser would have accepted, which is printable ASCII
 * and nothing else.
 *
 * µWS takes the target as it finds it and decodes it as UTF-8, so `GET /cafÃ©` arrives here
 * as a path with an é in it and the overlong encoding of a slash arrives as replacement
 * characters. Node refuses both with a 400 before any application sees them, and it has to: what
 * reaches req.url otherwise is not what is on the wire, and a proxy in front reading the same
 * bytes can disagree with this server about which path was asked for. Control characters are µWS's
 * own to refuse and it does, so the test is one comparison per character rather than two.
 *
 * @param {string} target the path or the query string, as µWS decoded it
 * @returns {boolean}
 */
function isAsciiTarget(target) {
    for (let i = 0; i < target.length; i++) {
        if (target.charCodeAt(i) > 0x7e) {
            return false;
        }
    }
    return true;
}

/**
 * Whether a transfer-encoding leaves the body's length knowable, which is RFC 9112's rule that
 * `chunked` comes last. `gzip, chunked` is fine and `chunked, gzip` is not: with a coding applied
 * after the framing one, nothing can say where the body ends, and node answers 400 rather than
 * guess. µWS guesses, and what it guesses wrong becomes the next request on the connection.
 *
 * Read per header rather than over the joined value, so a request splitting the list across two
 * transfer-encoding headers is refused even when the codings would be legal joined up. That is
 * stricter than node by a hair, on a shape nothing sends, and stricter is the safe direction here.
 *
 * @param {string} value one transfer-encoding header, as uWS hands it over
 * @returns {boolean}
 */
function endsWithChunked(value) {
    const last = value.slice(value.lastIndexOf(",") + 1).trim();
    // a coding may carry parameters, which are not part of its name
    const semicolon = last.indexOf(";");
    if ((semicolon === -1 ? last : last.slice(0, semicolon)).trim().toLowerCase() !== "chunked") {
        return false;
    }
    // and only once. "chunked, chunked" ends with it and is still nonsense: a sender may not frame
    // a body twice, and where node refuses the request outright µWS frames it as one chunked body
    // and reads whatever follows as the next request on the connection
    const codings = value.split(",");
    let chunkedCount = 0;
    for (const coding of codings) {
        const parameter = coding.indexOf(";");
        if ((parameter === -1 ? coding : coding.slice(0, parameter)).trim().toLowerCase() === "chunked") {
            chunkedCount++;
        }
    }
    return chunkedCount === 1;
}

/**
 * Whether a Connection header says the connection ends with this response.
 *
 * It is a list, and "keep-alive, close" closes as much as "close" alone does. Compared against an
 * exact "close", this server kept a connection the client had said it was done with, and then read
 * the bytes after it as another request: node closes there, so the two disagreed on how many
 * requests the same bytes carried, which is what a desync is.
 *
 * Written as a scan rather than a split and a lowercase, because almost every request that carries
 * this header carries "keep-alive", and both of those allocate per request.
 *
 * @param {string} value as µWS hands it over
 * @returns {boolean}
 */
function saysClose(value) {
    // what clients actually send, almost always: two interned compares answer before the scan
    if (value === "keep-alive") {
        return false;
    }
    if (value === "close") {
        return true;
    }
    const length = value.length;
    let at = 0;
    while (at < length) {
        while (at < length && (value.charCodeAt(at) === 0x20 || value.charCodeAt(at) === 0x09)) {
            at++;
        }
        const start = at;
        while (at < length && value.charCodeAt(at) !== 0x2c) {
            at++;
        }
        let end = at;
        while (end > start && (value.charCodeAt(end - 1) === 0x20 || value.charCodeAt(end - 1) === 0x09)) {
            end--;
        }
        if (
            end - start === 5 &&
            (value.charCodeAt(start) | 0x20) === 0x63 &&
            (value.charCodeAt(start + 1) | 0x20) === 0x6c &&
            (value.charCodeAt(start + 2) | 0x20) === 0x6f &&
            (value.charCodeAt(start + 3) | 0x20) === 0x73 &&
            (value.charCodeAt(start + 4) | 0x20) === 0x65
        ) {
            return true;
        }
        at++;
    }
    return false;
}

/**
 * The path of the url a request carries right now, without the query.
 *
 * Express reads it off req.url on every access, so a middleware that assigns req.url is seen by
 * whatever runs next, the callback after it in the same route included: the router only takes a
 * rewrite over at its next hop. The cached field answers while the two agree, which is every read
 * of a request nobody rewrote.
 *
 * @param {any} req
 * @returns {string}
 */
function currentPath(req) {
    const url = req.url;
    if (url === req._lastUrl) {
        return req._path;
    }
    const query = url.indexOf("?");
    return query === -1 ? url : url.slice(0, query);
}

/**
 * Whether a content-length is a plain count of bytes, which is the only thing RFC 9112 allows.
 *
 * uWS trims the spaces around the value and then takes whatever is left, so "", "abc", "+1", "-1",
 * "0x10" and "1e2" all arrive here. Every one of them makes uWS frame the request as carrying no
 * body, and what the client sent as a body is then read as the next request on the connection.
 * Node's parser refuses all of them outright, and so does this.
 *
 * @param {string} value as uWS hands it over
 * @returns {boolean}
 */
function isByteCount(value) {
    if (value.length === 0) {
        return false;
    }
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 0x30 || code > 0x39) {
            return false;
        }
    }
    // A count nothing can represent is not a count. Node refuses one that overflows, and µWS framed
    // the request as if it had said something else, which put the bytes after it in a request of
    // their own. The length test first, so an ordinary value never parses.
    if (value.length > 15 && Number(value) > Number.MAX_SAFE_INTEGER) {
        return false;
    }
    return true;
}

// Whose headers the shared collector below is filling. uWS's forEach is synchronous and runs no
// user code, so the handoff cannot interleave; module-level so the callback exists once instead
// of once per request.
let currentRequest = null;

/**
 * A Readable that has not been built yet.
 *
 * Every request pays for the stream and almost none of them use it: a GET carries no body, and the
 * bodies that do arrive are collected by µWS and handed to the parsers without the stream being
 * touched. Measured on this machine, running Readable's constructor costs about 90ns of the 900ns
 * a hello-world request costs in total, which is a tenth of it for a facility nobody asked for.
 *
 * So the chain says Readable and the constructor does not run. `Request extends LazyReadable`, and
 * LazyReadable's prototype is Readable's, which keeps `req instanceof Readable` true and every
 * Readable method reachable; what is missing is `_readableState`, and that is built on the first
 * touch. A derived class cannot skip its super() call, but a base class with nothing in it costs
 * nothing to call.
 *
 * The wrapping below is generated rather than written out, and deliberately: every own member of
 * Readable's prototype gets a version that materialises first, so there is no list to keep in step
 * and no door left unguarded. Missing one would not be a slow path, it would be a TypeError on
 * `undefined._readableState` in whatever corner of a stream nobody tested.
 */
class LazyReadableBase {}
Object.setPrototypeOf(LazyReadableBase.prototype, Readable.prototype);
Object.setPrototypeOf(LazyReadableBase, Readable);

// what the chain says at runtime, said again for the type checker, which cannot see a prototype
// being reassigned: everything a Readable offers is reachable from a Request, and is a Readable's
const LazyReadable = /** @type {typeof Readable} */ (/** @type {unknown} */ (LazyReadableBase));

/**
 * Builds the stream this object has been pretending to be. Idempotent: everything that can be
 * reached from outside goes through it, so it is called far more often than it does anything.
 *
 * EventEmitter's init keeps an _events that is already there, so listeners added before this
 * survive it.
 *
 * @param {any} stream
 */
function materialise(stream) {
    if (stream._readableState === undefined) {
        Readable.call(stream, READABLE_OPTIONS);
    }
}

for (const member of [
    ...Object.getOwnPropertyNames(Readable.prototype),
    ...Object.getOwnPropertySymbols(Readable.prototype)
]) {
    // the constructor is not a door, and `readable` is handled below because a request writes it
    // and writing it must not build the very thing this is avoiding
    if (member === "constructor" || member === "readable") {
        continue;
    }
    const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Readable.prototype, member));
    if (typeof descriptor.value === "function") {
        const inner = descriptor.value;
        Object.defineProperty(LazyReadableBase.prototype, member, {
            ...descriptor,
            /** @this {any} @param {...any} args */
            value: function (...args) {
                materialise(this);
                return inner.apply(this, args);
            }
        });
    } else if (descriptor.get || descriptor.set) {
        const innerGet = descriptor.get;
        const innerSet = descriptor.set;
        Object.defineProperty(LazyReadableBase.prototype, member, {
            ...descriptor,
            get: innerGet
                ? /** @this {any} */ function () {
                      materialise(this);
                      return innerGet.call(this);
                  }
                : undefined,
            set: innerSet
                ? /** @this {any} @param {any} value */ function (value) {
                      materialise(this);
                      innerSet.call(this, value);
                  }
                : undefined
        });
    }
}

const nodeReadable = /** @type {PropertyDescriptor} */ (
    Object.getOwnPropertyDescriptor(Readable.prototype, "readable")
);

// `readable` on its own: a request sets it while it is being built, and node's setter is a no-op
// without the state anyway, so the flag is kept as a plain field until there is a stream to ask
Object.defineProperty(LazyReadableBase.prototype, "readable", {
    configurable: true,
    enumerable: false,
    /** @this {any} */
    get: function () {
        return this._readableState === undefined
            ? this._readableFlag === true
            : /** @type {any} */ (nodeReadable.get).call(this);
    },
    /** @this {any} @param {any} value */
    set: function (value) {
        if (this._readableState === undefined) {
            this._readableFlag = !!value;
            return;
        }
        /** @type {any} */ (nodeReadable.set).call(this, value);
    }
});

module.exports = class Request extends LazyReadable {
    /** @type {Record<string, any>|null} */
    #cachedHeaders = null;

    /** @type {Record<string, string[]>|null} */
    #cachedDistinctHeaders = null;

    /**
     * Every header, flat: name then value, name then value.
     *
     * An array of pairs meant one array allocated per header on every request, and a request
     * carries eight or ten of them, so everything that reads this walks it two at a time. The
     * names are lowercase by contract: uWS lowers them on the wire and the node shim lowers
     * them in its forEach, so readers compare without lowering again.
     *
     * @type {string[]}
     */
    #rawHeadersEntries = [];

    /** @type {string|undefined|null} */
    #cachedParsedIp = null;

    /** Whether backpressure has asked uWS to stop delivering the body for now. */
    #paused = false;

    /** A bodyless request whose empty end has not been delivered yet, see the constructor. */
    #emptyBody = false;

    // `body` is deliberately not declared here. A class field would put the property on every
    // request, and on Express there is none until a body parser assigns one. `"body" in req` is how
    // a library asks whether the body has already been read, and tRPC's express adapter asks
    // exactly that: answering yes on a request nobody had parsed handed it an undefined body and
    // turned every mutation into "Unexpected end of JSON input". Its type lives in types.d.ts,
    // where the rest of the public request surface is described.

    /**
     * The response this request arrived with, linked so either reaches the other.
     *
     * Typed loosely on purpose: it is linked right after construction rather than in the
     * constructor, and the honest `Response|undefined` would put a check in front of every
     * use of a field that is never observed unset.
     *
     * @type {any}
     */
    res;

    /**
     * Copies one header out of uWS and notices the two things the constructor decides by.
     *
     * One function for every request, fed through currentRequest: an arrow in the constructor
     * captured `this`, which cost a context and a function allocation per request.
     *
     * @param {string} headerKey lowercase, as uWS hands it over
     * @param {string} value
     */
    static #collectHeader = (headerKey, value) => {
        const r = currentRequest;
        r.#rawHeadersEntries.push(headerKey, value);
        // spotted in the loop that is running anyway: a client asking for the connection to be
        // closed must not be answered that it is being kept alive. The response is built right
        // after this and reads the flag.
        if (headerKey.length === 10 && headerKey === "connection" && saysClose(value)) {
            r._connectionClose = true;
        } else if (
            (headerKey.length === 14 && headerKey === "content-length") ||
            (headerKey.length === 17 && headerKey === "transfer-encoding")
        ) {
            if (headerKey.length === 14) {
                // a second content-length whatever it says, and one that is not a count of bytes:
                // both make uWS frame the request differently from what is on the wire, see
                // _mustRefuse and isByteCount
                if (r._sawContentLength || !isByteCount(value)) {
                    r._mustRefuse = true;
                }
                r._sawContentLength = true;
            } else if (!endsWithChunked(value)) {
                // chunked has to be the last coding: anything after it and the length of the body
                // is not knowable, which node answers 400 to and µWS served. See endsWithChunked
                r._mustRefuse = true;
            }
            // saying anything about framing at all, "0" included. A parser that can see a
            // content-length answers about the body it describes, even an empty one: a zero length
            // with a charset nobody can decode is a 415 in express and here, so a chain may only
            // step over a parser when the request said nothing about a body whatsoever
            r._hasBodyHeaders = true;
            // content-length: 0 declares that there is nothing, which is the same as declaring
            // nothing: the stream ends empty either way, without the onData subscription
            if (value !== "0" || headerKey.length === 17) {
                // noticed here so the body decision in the constructor does not build the headers object
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
     * Which hop the error being carried came from, so an error handler declared before it does
     * not catch what happened after it.
     * @type {number|undefined}
     */
    _errorKey;

    /**
     * Which app.route() the failing route belonged to, when it belonged to one. Express builds one
     * route out of everything hung off an app.route(), so an error handler written on it catches
     * what its siblings raised, and nothing else does.
     * @type {number|undefined}
     */
    _errorGroup;

    /**
     * How much of _originalPath the mounts entered so far have taken. Kept as a count rather than
     * worked out from the mount patterns, because what a mount took is what it matched, and a
     * pattern rebuilt from the whole stack does not always match the same thing.
     * @type {number}
     */
    _consumed = 0;

    /**
     * next() as the router means it: the rest of the route is skipped. res.sendFile reports its
     * failures here, because express reports them to the router and not to the route.
     * @type {((err?: any) => void)|undefined}
     */
    _leaveRoute;

    /**
     * What `readable` answers while there is no stream to ask, see LazyReadable. Declared so the
     * class has one shape whether or not anything ever streams.
     * @type {boolean}
     */
    _readableFlag = true;

    /**
     * The peer address as uWS hands it over, sixteen bytes or four.
     *
     * Declared although the constructor only sometimes fills it in: a property that appears on
     * some requests and not others gives the class more than one shape, and every read of every
     * other field pays for that.
     *
     * @type {ArrayBuffer|undefined}
     */
    rawIp;

    /**
     * Whether rawIp came from a PROXY protocol preamble rather than from the socket. Only the
     * IPv4 mapping reads it, see parsedIp. Declared for the same reason as rawIp.
     * @type {boolean}
     */
    _ipFromProxy = false;

    /**
     * Whether the request declared a body, content-length or transfer-encoding, spotted during
     * the header copy. Declared for the same reason as rawIp.
     * @type {boolean|undefined}
     */
    _declaresBody;

    /**
     * Whether the request said anything at all about framing, a content-length of "0" included.
     * Wider than _declaresBody on purpose: a parser that can see a content-length answers about
     * the body it describes even when that body is empty, so this is what decides whether a chain
     * may step over one. Declared for the same reason as rawIp.
     * @type {boolean|undefined}
     */
    _hasBodyHeaders;

    /**
     * Whether a content-length has already been copied, so a second one is spotted. Declared for
     * the same reason as rawIp.
     * @type {boolean|undefined}
     */
    _sawContentLength;

    /**
     * Whether this request must not be routed at all. Node's parser refuses each of these outright
     * and answers 400; every one of them is a way for bytes the client did not send as a request to
     * be served as one, which is request smuggling.
     *
     *   a repeated content-length     uWS frames on the first and drops the rest, so a proxy in
     *                                 front reading the last one instead forwards bytes uWS then
     *                                 answers as a second, pipelined request
     *   one that is not a byte count  uWS keeps whatever is left after trimming, an empty value
     *                                 included, and frames the request as carrying no body at all,
     *                                 which turns the body the client sent into that same second
     *                                 request. See isByteCount
     *   a method nobody defines       uWS takes any token as the method, so anything at all
     *                                 followed by a space and a path is a request line to it. A
     *                                 request with no content-length and no transfer-encoding has
     *                                 no body, so the bytes after it are the next request: node
     *                                 reads them and answers 400, uWS served them. See KNOWN_METHODS
     *
     * Declared for the same reason as rawIp.
     *
     * @type {boolean|undefined}
     */
    _mustRefuse;

    /**
     * Whether the client asked for the connection to be closed. Declared for the same reason.
     * @type {boolean|undefined}
     */
    _connectionClose;

    /**
     * The continuation of the chain currently running, which express also hands to a handler
     * through the request. Declared rather than left to appear on assignment: runRoute sets it
     * on every request, and an undeclared property is a shape change on each one.
     *
     * @type {any}
     */
    next;

    /**
     * What the chain threw or passed to next(err), waiting for an error handler.
     * @type {any}
     */
    _error;

    /**
     * Set by the paths that must not earn an ETag, res.sendFile's stream among them.
     * @type {boolean|undefined}
     */
    noEtag;

    /**
     * The decoded pairs of the first default-parser parse of req.query, flat key,value; false
     * when it saw a repeated key, which a flat replay cannot reproduce. See `get query`.
     * @type {string[]|false|undefined}
     */
    _querySnap;

    /**
     * The raw string _querySnap came from: a url rewrite replaces _rawQuery.
     * @type {string|undefined}
     */
    _querySnapRaw;

    /**
     * Built for every request, which is why so little happens here. The headers are copied out
     * because uWS only lends them for this call, everything derived from them waits until something
     * asks, and the body is subscribed to only for the methods that carry one.
     *
     * @param {any} req the uWS request, readable only during this call
     * @param {any} res the uWS response
     * @param {any} app the application or router this request arrived at
     * @param {any} [preset] a literal native registration's constants: µWS matched the URL byte
     *   for byte against that exact pattern and dispatched by method, so path, method and what
     *   derives from them are known without asking
     * @param {any} [skipHolder] where a granted header skip lives: the preset itself for a
     *   literal registration, a holder of its own for a parameterised one
     */
    constructor(req, res, app, preset, skipHolder) {
        // nothing: the stream is built on the first touch, see LazyReadable
        super();
        this._res = res;
        this._req = req;
        if (skipHolder !== undefined && skipHolder.skipHeaders) {
            // The chain behind this registration provably never reads a header, so instead of
            // copying them all out of uWS the constructor asks for the ones that steer the
            // framework itself: body framing, keep-alive, and the conditional pair. A GET that
            // does declare a body is the rare case, and the parsers and the stream want the
            // whole picture, so it takes the full copy.
            //
            // A handful of named reads against one forEach looks like it should lose, and does
            // not: measured at seven reads they were flat at 0.75us however many headers are on
            // the wire, since each one is a napi crossing and the scan behind it is nothing,
            // while the copy pays a hop back into JS per header and grows, 1.16us at four
            // headers, 1.61 at eight, 2.90 at sixteen. They do not cross, and the gap widens
            // exactly where real traffic lives, since a browser sends a dozen or more. The body
            // case pays two reads and then copies anyway, which is 0.2us on a request that is
            // about to read a body.
            //
            // accept is not read: nothing on a granted chain consumes it, the error and 404
            // pages are fixed HTML that never negotiate.
            const length = req.getHeader("content-length");
            const transferEncoding = req.getHeader("transfer-encoding");
            // A content-length of "0" declares no body and used to stay on the cheap side, but
            // getHeader only ever returns the first of a repeated header, so a duplicate cannot be
            // seen from here, and a duplicate has to be refused rather than routed: see
            // _mustRefuse. Anything that says a word about framing takes the full copy instead.
            //
            // One shape stays invisible here, a content-length present with an empty value: uWS
            // answers "" for that and for a header that was never sent, and nothing in its API
            // tells them apart. It frames both as carrying no body, which is the right reading of
            // the second, so this server stays consistent with itself either way. The full copy
            // below does refuse it, which is every request except a GET whose whole chain provably
            // reads no header at all.
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
                // send consults freshness whatever the etag setting: if-none-match can be "*"
                // and a handler may set a validator by hand, so the conditional pair has to be
                // really absent rather than merely uncopied
                const ifNoneMatch = req.getHeader("if-none-match");
                if (ifNoneMatch !== "") {
                    entries.push("if-none-match", ifNoneMatch);
                }
                const ifModifiedSince = req.getHeader("if-modified-since");
                if (ifModifiedSince !== "") {
                    entries.push("if-modified-since", ifModifiedSince);
                }
                // fresh() answers false before it reads cache-control unless a conditional
                // arrived, so the read only pays on the requests that can use it
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
        this.routeCount = 1;
        this.app = app;
        // both forms are kept, because both are asked for: the query with its "?" goes into
        // req.url, and req.query parses the raw one. Keeping only the first meant slicing the "?"
        // back off for every request that reads req.query. When the chain provably reads
        // neither, the native call is not made at all: the framework's own answers, the 404
        // included, are written from the path alone
        if (skipHolder !== undefined && skipHolder.skipQuery) {
            this._rawQuery = "";
            this.urlQuery = "";
        } else {
            // getQuery tells "/a" from "/a?": no query string at all reads undefined, an empty
            // one reads "". Express keeps that lone "?" in req.url, so the two are kept apart
            const rawQuery = req.getQuery();
            this._rawQuery = rawQuery ?? "";
            this.urlQuery = rawQuery === undefined ? "" : "?" + rawQuery;
            if (rawQuery !== undefined && rawQuery.length !== 0 && !isAsciiTarget(rawQuery)) {
                this._mustRefuse = true;
            }
        }
        if (preset) {
            // the registration's constants: two native crossings and their strings not asked for
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
            // getUrl() is the path already, so the query is joined on and then not split off
            // again. Building originalUrl and picking the path back out of it with indexOf and
            // substring was a search and a second string for something uWS had just handed over.
            this._path = req.getUrl();
            // the target as it arrived, which node would have refused before this ran. A preset
            // needs no check: it is a literal registration, and µWS only matched it because the
            // bytes were that literal
            if (!isAsciiTarget(this._path)) {
                this._mustRefuse = true;
            }
            this.originalUrl = this._path + this.urlQuery;
            this.url = this.originalUrl;
            // what the router last wrote to req.url. A middleware assigning something else is a
            // rewrite, which express honours, and dispatch compares against this to notice it
            this._lastUrl = this.originalUrl;
            // charCodeAt rather than indexing: s[i] builds a one character string to throw away
            this.endsWithSlash = this._path.charCodeAt(this._path.length - 1) === 0x2f;
            this._opPath = this._path;
            this._originalPath = this._path;
            const rawMethod = req.getCaseSensitiveMethod();
            if (skipHolder !== undefined && rawMethod === skipHolder.method) {
                // the registration's constant, byte for byte; any other spelling, "get" that µWS
                // folded here included, takes the full check below
                this.method = rawMethod;
                this._isOptions = skipHolder.isOptions;
                this._isHead = skipHolder.isHead;
            } else {
                this.method = rawMethod.toUpperCase();
                // node's parser knows a fixed set and refuses everything else; µWS takes the token
                // as it finds it, so a request line is anything with a space in it. Compared before
                // the uppercasing on purpose: a method is case sensitive, node refuses "post", and
                // µWS folds it to POST and serves it. Only asked of a method the framework cannot
                // route anyway, since a route can only be registered for one of these, see the loop
                // that builds the verb methods at the end of router.js
                if (!KNOWN_METHODS.has(rawMethod)) {
                    this._mustRefuse = true;
                }
                this._isOptions = this.method === "OPTIONS";
                this._isHead = this.method === "HEAD";
            }
        }
        // what the router last saw as the method. A middleware assigning another one is a rewrite,
        // which express honours because it reads req.method at every layer, and dispatch compares
        // against this to notice it
        this._lastMethod = this.method;
        // the folded _opPath and the percent scan of _originalPath, built on the hop that first
        // wants them and dropped by every rewrite, see _pathMatches and Walk#dispatch
        this._opPathLower = null;
        this._mayFailDecode = null;
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
        // whether one of them took a trailing slash, which only a RegExp mount can: see baseUrl
        this._mountSlash = false;
        this._paramStack = null;
        // route and application in pairs, one pair per mounted application entered from another
        // application, so handing back puts the one that was current back, see rememberApp
        this._appStack = undefined;
        this.receivedData = false;
        // reading ip is very slow in UWS, so its better to not do it unless truly needed
        if (app.needsIpAfterResponse) {
            // an app that has been seen asking after the response reads it now, because by then
            // µWS has freed it
            this.rawIp = this._readRawIp();
        } else if (app._ipProbes < 100) {
            // and until this app has been seen either way, the first hundred requests read it, so
            // one of them can be the one that finds out
            app._ipProbes++;
            this.rawIp = this._readRawIp();
        }

        // A body exists on the wire only when the request declares one, content-length or
        // transfer-encoding, whatever the verb, and that evidence was spotted during the header
        // copy. The verb list and the "body methods" settings read this branch used to pay per
        // request said nothing the headers had not already said; the setting still gates the
        // body parsers, which is where it matters
        if (/** @type {any} */ (this)._declaresBody) {
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
     * One header by its lowercase wire name, straight from the raw entries. The body parsers ask
     * for three of these per request, and materializing the whole headers object for that costs
     * more than all three scans together. Reads the built object instead when it already exists,
     * so joined duplicates come out the same either way.
     *
     * @param {string} name lowercase
     * @returns {string|undefined}
     */
    _rawHeader(name) {
        if (this.#cachedHeaders !== null) {
            return this.#cachedHeaders[name];
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
     * Whether there is any point still reading the body: once the response is finished or the
     * connection is gone, uWS has nothing left to hand over.
     */
    get #responseEnded() {
        return this.res?.finished || this.res?.aborted;
    }

    /** @type {AbortController|undefined} */
    #abortController;

    /**
     * node's `req.signal`, an AbortSignal that fires when the request is over, so work started for
     * a visitor who has gone away can be stopped. `@angular/ssr` reads it when it builds a web
     * Request out of this one, which is how an SSR render learns to give up.
     *
     * Made on the first ask rather than for every request: most requests never look at it, and an
     * AbortController each would be an allocation nobody reads.
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
                // the request, not the response: a client abort is reported by destroying this
                // stream and emitting "aborted" on it, and the response is never told to close
                this.once("aborted", stop);
                this.once("close", stop);
            }
        }

        return this.#abortController.signal;
    }

    /**
     * The trailing headers of a chunked request. µWebSockets.js does not surface them, so these
     * stay empty, which is also what node hands back until the request has ended.
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
     * node's per-request socket timeout. µWS runs its own idle timeout, set through
     * `uwsOptions.idleTimeout`, and this cannot change it. The listener is registered as node's is.
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
        if (this._consumed === 0) {
            return "";
        }
        // what the mounts took, which is where the path they left off begins
        if (this._mountSlash !== true) {
            return this._originalPath.slice(0, this._consumed);
        }
        // Express drops one trailing slash off each mount before joining them, so this is a join
        // of the pieces rather than one slice of the path: a RegExp mount ending in "/" matched
        // against "/a//b" takes "/a/" and reads back as "/a", and what the mount below it took is
        // appended to that rather than to the original. Only a RegExp mount can take a trailing
        // slash, a registered path having had it removed, so almost every request answers above.
        let out = "";
        let at = 0;
        for (let taken of this._stack) {
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
        const trust = this.app._hot().trustProxyFn;
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
     * "http" or "https", taken from X-Forwarded-Proto when the connection comes from a
     * trusted proxy.
     * @returns {string}
     */
    get protocol() {
        // express reads socket.encrypted, and middleware does assign to the stand-in; the app's
        // own ssl flag answers when nothing has built the stand-in yet
        const conn = this.#cachedConnection;
        const proto = (conn ? conn.encrypted : this.app.ssl) ? "https" : "http";
        const trust = this.app._hot().trustProxyFn;
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
     * The path of the current url, without the query and relative to the mount the request is in.
     * A getter rather than a field, because express recomputes it from req.url on every read, see
     * currentPath.
     *
     * @returns {string}
     */
    get path() {
        return currentPath(this);
    }

    /**
     * Takes over what a middleware assigned to req.url: the remaining routing matches the new
     * path, and req.query reflects the new query string. The assigned url is relative to the
     * mount the request is currently in, as it is in express, so the absolute path is rebuilt
     * from the piece the mounts had consumed.
     *
     * @param {boolean} [leavingMount] the caller is popping the mount the rewrite happened in
     */
    _absorbUrlRewrite(leavingMount) {
        const assignedUrl = String(this.url);
        let newUrl = assignedUrl;
        // the prefix the mounts consumed: everything of the absolute path the relative one was not
        const lastQueryIndex = this._lastUrl.indexOf("?");
        const oldPath = lastQueryIndex === -1 ? this._lastUrl : this._lastUrl.slice(0, lastQueryIndex);
        let prefix;
        if (oldPath === "/" && !this._originalPath.endsWith("/")) {
            prefix = this._originalPath;
            // express's slashAdded restore, applied where express applies it, on the way out of a
            // mount that consumed the whole path: the "/" the middleware saw was invented, and the
            // rejoin strips the first character of whatever was assigned ("/found" + "target" is
            // "/foundtarget"). Inside the mount the assigned url routes as it is, as express does
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
        // the assigned string, not the mangled one: the compare against req.url must go quiet or
        // the next hop absorbs the same rewrite again with a different prefix
        this._lastUrl = assignedUrl;
    }

    /**
     * Takes over what a middleware assigned to req.method. Both flags are read as bare fields by
     * the routing scan rather than compared against req.method, so they are what has to follow it,
     * and an OPTIONS the request has just become still needs the set the verbs are collected in.
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
     * The query string parsed by whichever parser the "query parser" setting names. A null-prototype
     * object, so a key like "__proto__" cannot reach Object.prototype. No setter, so assigning to
     * req.query throws as it does on Express.
     *
     * Every read answers a new object, because express's getter re-parses on every read and so hands
     * one back too. Two consequences an application can see, and both of them bite: `req.query` is
     * never the object another reader holds, and a write to a key of it is gone by the next read.
     * That second one is how express-validator's sanitisers behave: `.trim()` on a query parameter
     * changes nothing an ordinary handler will see, which is why it also offers matchedData(). With
     * the parse cached and handed out as itself, the sanitised value leaked into req.query here and
     * a handler written against express read a trimmed value where express gives it the raw one.
     *
     * And that is why there is no cache of the object: the fresh object comes from the raw
     * string, not from copying a kept parse. As first shipped this was parse-once-copy-per-read,
     * and the copy was the expensive half: Object.assign between null-prototype objects, which
     * live in V8's dictionary mode, measured 638ns for a two-parameter query where parsing the
     * same string measures 119ns, and on a benchmark whose every request carries such a query it
     * cost +1.5us of CPU per request, which a public arena saw as -8% on its query-carrying rows.
     *
     * The default parser does keep the decoded pairs of its first parse, and a later read of the
     * same raw string replays the stores into a fresh null-prototype object: identical output,
     * still nothing shared between reads. A repeated key cannot be replayed and re-parses.
     *
     * @returns {Record<string, any>}
     */
    get query() {
        const qp = this.app._hot().queryParserFn;
        // the vendored default already answers on a bare null prototype, so it goes out as is;
        // any other parser is copied onto one, which is what kept fast-querystring's result from
        // inspecting as "Empty <[Object: null prototype] {}>" where Express shows the bare form
        // A parser of the application's own is handed what express hands it, which is
        // parseurl's `query`: null when the url carries no "?" at all, and the text after it
        // otherwise, the empty string included. Passing "" for both meant a parser written for
        // express, which may check for null before it reads the string, saw a request that had no
        // query as one with an empty query. The two built in parsers take the raw string.
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
     * The peer address bytes, from the socket or, when the application asked for it, from a PROXY
     * protocol preamble the load balancer in front of this server sent ahead of the request.
     *
     * The setting is off by default and has to stay that way. µWS parses the preamble from whoever
     * sends it, with nothing to ask for it at listen time and no way to restrict who may, so an
     * application that took the address unconditionally would let any client claim any address:
     * the first sixteen bytes of a connection are enough to become 10.0.0.1 for a rate limiter, an
     * allow list or an audit log. Turn it on only when nothing can reach this server except the
     * proxy in front of it.
     *
     * @returns {ArrayBuffer} the socket's own address when no preamble arrived
     */
    _readRawIp() {
        const uwsRes = this._res;
        if (this.app._hot().trustProxyProtocol) {
            const proxied = uwsRes.getProxiedRemoteAddress();
            // empty unless a preamble arrived, which is the only thing that tells the two apart
            if (proxied.byteLength !== 0) {
                this._ipFromProxy = true;
                return proxied;
            }
        }
        return uwsRes.getRemoteAddress();
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
            this.rawIp = this._readRawIp();
        }
        // read once: the branch above settled it, and every use below wants the bytes
        const rawIp = /** @type {ArrayBuffer} */ (this.rawIp);
        /** @type {string|undefined} */
        let ip;
        if (rawIp.byteLength === 4) {
            // ipv4
            ip = new Uint8Array(rawIp).join(".");
            // the mapped form belongs to a dual stack listener, which is what makes an IPv4 peer
            // arrive as ::ffff:a.b.c.d. An address a proxy declared never came through that socket,
            // so it is left as the four numbers the proxy sent
            if (!this._ipFromProxy && mapsIPv4Peer(this.app)) {
                ip = "::ffff:" + ip;
            }
        } else if (rawIp.byteLength === 16) {
            const bytes = new Uint8Array(rawIp);
            if (isMappedIPv4(bytes)) {
                // ::ffff:a.b.c.d, which is what a dual stack listener hands over for every IPv4
                // peer, so it is what nearly every request here is. The general path below reaches
                // the same string through a DataView, an array of eight groups and a scan for the
                // longest run of zeros, and measured 157ns more per request for it. Anything that
                // reads req.ip pays that once, and morgan reads it on every line it writes.
                ip = "::ffff:" + bytes[12] + "." + bytes[13] + "." + bytes[14] + "." + bytes[15];
            } else {
                // ipv6
                const dv = new DataView(rawIp);
                const groups = new Array(8);
                for (let i = 0; i < 8; i++) {
                    groups[i] = dv.getUint16(i * 2);
                }
                ip = formatIPv6(groups);
            }
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
     * Cuts this request loose from the µWS response it arrived on, keeping the two things only
     * that response could answer.
     *
     * A websocket upgrade hands the request to the socket, which outlives the response by the
     * whole life of the connection. Reading the peer address through the freed response is not
     * an error but a use after free, so the values are taken while it is still alive and an
     * inert stand-in answers anything that asks later.
     */
    _detachFromResponse() {
        const uwsRes = this._res;
        if (!this.rawIp) {
            this.rawIp = this._readRawIp();
        }
        const remotePort = uwsRes.getRemotePort();
        const rawIp = this.rawIp;
        this._res = {
            getRemoteAddress: () => rawIp,
            // whatever a preamble said is already in rawIp, and asking again is the use after free
            // this method exists to avoid
            getProxiedRemoteAddress: () => emptyAddress,
            getRemotePort: () => remotePort,
            // a body cannot arrive on an upgraded socket, and a stray reader must not reach µWS
            onData() {},
            pause() {},
            resume() {},
            close() {}
        };
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
            // own values are never undefined, so the read answers "absent" without the hasOwn
            // call; a prototype-named header reads truthy and still takes the hasOwn check
            if (headers[key] !== undefined && Object.hasOwn(headers, key)) {
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
