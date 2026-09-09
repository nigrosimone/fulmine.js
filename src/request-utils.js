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

const { isIP } = require("node:net");

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

module.exports = {
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
};
