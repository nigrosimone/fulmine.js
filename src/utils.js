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

const mime = require("mime-types");
const path = require("path");
const proxyaddr = require("proxy-addr");
const qs = require("qs");
const parseQuery = require("./parse-query.js");
const crypto = require("crypto");
const statuses = require("statuses");
const ms = require("ms");
const fs = require("fs");
const { Stats } = require("fs");

/** @typedef {import("./request.js")} Request */
/** @typedef {import("./response.js")} Response */
/**
 * An error with the http-errors fields, none required: a plain throw carries none.
 * @typedef {Error & {
 *   status?: number,
 *   statusCode?: number,
 *   expose?: boolean,
 *   code?: string,
 *   type?: string,
 *   types?: string[],
 *   headers?: Record<string, any>
 * }} HttpError
 */

const EMPTY_REGEX = new RegExp(``);

// what express hands qs: allowPrototypes keeps a "constructor" key, inert on the null prototype below
const QUERY_QS_OPTIONS = { allowPrototypes: true };

/**
 * The "extended" parser, qs, without paying for qs where it cannot be needed: a short query with no
 * bracket and no dot goes through fast-querystring, several times quicker, same answer.
 *
 * @param {string} query the query string, without the leading "?"
 * @param {object} [options] passed through to qs when it is used
 * @returns {Record<string, any>} null-prototype
 */
function fastQueryParse(query, options) {
    const len = query.length;
    if (len === 0) {
        return Object.create(null);
    }
    if (len <= 128) {
        // an empty name ("=v", "a=1&=2") is a pair to fast-querystring and nothing to qs
        if (
            !query.includes("[") &&
            !query.includes("%5B") &&
            !query.includes(".") &&
            !query.includes("%2E") &&
            query.charCodeAt(0) !== 0x3d &&
            !query.includes("&=")
        ) {
            const parsed = parseQuery(query);
            // qs drops a "__proto__" key whatever allowPrototypes says; an own property here
            if (parsed.__proto__ !== undefined) {
                delete parsed.__proto__;
            }
            return parsed;
        }
    }
    return Object.assign(Object.create(null), qs.parse(query, options ?? QUERY_QS_OPTIONS));
}

/**
 * Collapses runs of slashes, //a///b to /a/b, as Express does before matching.
 *
 * @param {string} path
 * @returns {string}
 */
function removeDuplicateSlashes(path) {
    return path.replace(/\/{2,}/g, "/");
}

// a parameter name is a javascript identifier to path-to-regexp: /:café is a name, \w stops at ASCII
const ID_START = /[$_\p{ID_Start}]/u;
// the two joiners are written as escapes on purpose: as themselves they are invisible here
const ID_CONTINUE = /[$\u200c\u200d\p{ID_Continue}]/u;

/**
 * Reads a parameter name out of a pattern, by code points so a surrogate pair is read whole.
 *
 * @param {string} text the pattern, or the contents of one optional group
 * @param {number} from the index just past the ":" or the "*"
 * @returns {{name: string, next: number}} the name, empty when there is none, and where it ended
 */
function readParamName(text, from) {
    let i = from;
    let name = "";
    while (i < text.length) {
        const char = String.fromCodePoint(/** @type {number} */ (text.codePointAt(i)));
        if (!(name === "" ? ID_START : ID_CONTINUE).test(char)) {
            break;
        }
        name += char;
        i += char.length;
    }
    return { name, next: i };
}

/**
 * Escapes a string for use inside a regular expression, as path-to-regexp escapes it.
 * @param {string} str
 * @returns {string}
 */
function escapeRe(str) {
    return str.replace(/[.+*?^${}()[\]|/\\]/g, "\\$&");
}

/**
 * path-to-regexp's negate(): a class matching anything but what these two strings could start, so
 * a capture cannot backtrack over the literal text after it.
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function negate(a, b) {
    if (b.length > a.length) {
        return negate(b, a);
    }
    if (a === b) {
        b = "";
    }
    if (b.length > 1) {
        return `(?:(?!${escapeRe(a)}|${escapeRe(b)})[^])`;
    }
    if (a.length > 1) {
        return `(?:(?!${escapeRe(a)})[^${escapeRe(b)}])`;
    }
    return `[^${escapeRe(a + b)}]`;
}

// a named capture group opening, how the names are read back out of a finished pattern
const NAMED_GROUP = /\(\?<([^>]+)>/g;

/**
 * What a compiled pattern captures. Beside the regex and not on it: one own property takes a
 * RegExp off V8's fast path, replace() 37ns to 808ns, test() 22ns to 78ns.
 *
 * @typedef {{wildcardNames: string[], paramNames: string[], outputNames: string[], isWildcard: boolean[]}} PatternMeta
 */
const patternMeta = new WeakMap();

/**
 * What patternToRegex worked out, undefined for the application's own RegExp.
 * @param {RegExp} pattern
 * @returns {PatternMeta|undefined}
 */
function getPatternMeta(pattern) {
    return patternMeta.get(pattern);
}

/** @typedef {RegExp} PathRegExp */

/**
 * Compiles a path into a regex, following path-to-regexp v8: `:param` one segment, `/*splat` one
 * or more captured as an array, `{...}` optional, `\x` an escaped literal. A bare `*`, an unnamed
 * parameter, an inline regex and `+`, `?`, `()` throw at startup, as v8 does. The names go in a
 * WeakMap beside the regex, see PatternMeta.
 *
 * @param {string|RegExp} pattern
 * @returns {RegExp}
 */
function patternToRegex(pattern, isPrefix = false, caseSensitive = true, strict = false) {
    if (pattern instanceof RegExp) {
        // the application's own RegExp matches as written, as in express
        return pattern;
    }
    if (isPrefix && pattern === "") {
        return EMPTY_REGEX;
    }

    let regexPattern = "";
    let i = 0;
    const len = pattern.length;
    const wildcardNames = /** @type {string[]} */ ([]);
    // express takes /:a/:a and two groups cannot share a name: a repeat gets a spelling of its
    // own, mapped back on the way out, and the last occurrence wins as express reports it
    const groupOutputName = /** @type {Map<string, string>} */ (new Map());
    /** @param {string} name */
    const uniqueGroupName = (name) => {
        if (!groupOutputName.has(name)) {
            groupOutputName.set(name, name);
            return name;
        }
        let n = 2;
        while (groupOutputName.has(name + "$" + n)) n++;
        const group = name + "$" + n;
        groupOutputName.set(group, name);
        return group;
    };
    // whether the token just emitted was a :parameter or a wildcard, read by the next optional group
    let lastTokenWasParam = false;
    // the wildcard just emitted, so an optional group right after it can rewrite the two into one
    // alternation, see the { branch
    let lastWildcard = /** @type {{start: number, body: string, name: string}|null} */ (null);
    let lastWildcardEnd = -1;
    // path-to-regexp's backtrack: the literal text since the last capture, and since the last
    // wildcard. A later wildcard is held to one segment, /*a/*b would divide /x/y/ two ways
    let backtrack = "";
    let wildcardBacktrack = "";
    let lastCaptureWasWildcard = false;
    let wildcardInSegment = false;
    let paramInSegment = false;
    /** @param {string} text literal text as it is emitted */
    const literal = (text) => {
        backtrack += text;
        if (lastCaptureWasWildcard) {
            wildcardBacktrack += text;
        }
        if (text.includes("/")) {
            wildcardInSegment = false;
            paramInSegment = false;
        }
    };
    /**
     * Whether a wildcard is still to come in this segment, so the parameters before it give ground.
     *
     * @param {number} from where to look from
     * @returns {boolean}
     */
    const wildcardLaterInSegment = (from) => {
        for (let j = from; j < len; j++) {
            const c = pattern[j];
            if (c === "\\") {
                j++;
            } else if (c === "/") {
                return false;
            } else if (c === "*") {
                return true;
            }
        }
        return false;
    };
    /**
     * The literal text right after this point, which the capture before it must not swallow.
     *
     * @param {number} from
     * @returns {string}
     */
    const textAfter = (from) => {
        let out = "";
        for (let j = from; j < len; j++) {
            const c = pattern[j];
            if (c === "\\") {
                out += pattern[++j] ?? "";
                continue;
            }
            if (":*{}".includes(c)) {
                break;
            }
            out += c;
        }
        return out;
    };
    /** A :parameter ends the run of text and stops the wildcard one from growing. */
    const noteParam = () => {
        backtrack = "";
        lastCaptureWasWildcard = false;
        paramInSegment = true;
        lastTokenWasParam = true;
    };
    /**
     * What a wildcard may match here: the first one everything, one sharing a segment with an
     * earlier one stops at the text between them, one in a later segment is held to that segment.
     *
     * @returns {string} the body of the capture group
     */
    const wildcardClass = () => {
        const body = wildcardInSegment
            ? `${negate(backtrack, "")}+`
            : wildcardBacktrack
              ? `${negate(wildcardBacktrack, "")}+|${negate("/", "")}+`
              : "[^]+";
        backtrack = "";
        wildcardBacktrack = "";
        lastCaptureWasWildcard = true;
        wildcardInSegment = true;
        return body;
    };

    while (i < len) {
        const ch = pattern[i];

        if (ch === "\\" && i + 1 < len) {
            regexPattern += "\\" + pattern[i + 1];
            literal(pattern[i + 1]);
            i += 2;
            continue;
        }

        // *splat: one or more characters, slashes included; /te*st is "/te" then a wildcard "st"
        if (ch === "*") {
            const at = i;
            const splat = readParamName(pattern, i + 1);
            const name = splat.name;
            i = splat.next;
            if (!name) {
                throw new Error(
                    `Missing parameter name at index ${at + 1}: ${pattern}; visit https://git.new/pathToRegexpError for info`
                );
            }
            const splatGroup = uniqueGroupName(name);
            wildcardNames.push(splatGroup);
            const body = wildcardClass();
            lastWildcard = { start: regexPattern.length, body, name };
            regexPattern += `(?<${splatGroup}>${body})`;
            lastWildcardEnd = regexPattern.length;
            // a following group is held to one segment, as after a parameter
            lastTokenWasParam = true;
            continue;
        }

        if (ch === "{") {
            // {*splat}: zero or more segments, so it also matches the mount point
            if (pattern[i + 1] === "*") {
                i += 2;
                let name = "";
                while (i < len && pattern[i] !== "}") {
                    name += pattern[i++];
                }
                i++;
                if (!name) {
                    throw new Error(`Wildcard must be named in Express 5: use {*splat} (in "${pattern}")`);
                }
                const optionalGroup = uniqueGroupName(name);
                wildcardNames.push(optionalGroup);
                if (regexPattern.endsWith("/") || regexPattern.endsWith("\\/")) {
                    // the slash is part of the alternative as express compiles it: /a/{*w} answers
                    // /a/ and /a/x, not /a. Non-strict loosens a trailing slash instead
                    regexPattern = regexPattern.slice(0, regexPattern.endsWith("\\/") ? -2 : -1);
                    regexPattern += strict
                        ? `(?:/(?<${optionalGroup}>${wildcardClass()})|/)`
                        : `(?:/(?<${optionalGroup}>${wildcardClass()}))?/?`;
                } else {
                    regexPattern += `(?<${optionalGroup}>${wildcardClass()}|)`;
                }
                lastTokenWasParam = false;
                continue;
            }

            // optional group, which may itself contain a parameter: {.:ext}, {/:page}
            i++;
            let groupContent = "";
            let braceDepth = 1;
            while (i < len && braceDepth > 0) {
                if (pattern[i] === "{") braceDepth++;
                else if (pattern[i] === "}") {
                    braceDepth--;
                    if (braceDepth === 0) break;
                }
                groupContent += pattern[i++];
            }
            if (braceDepth > 0) {
                throw new Error(`Unexpected end at index ${len}, expected }: ${pattern}`);
            }
            i++;

            // After a :parameter this one must not swallow the separator: express splits /a.b.c
            // against /:file{.:ext} as file=a.b, ext=c. After static text it takes everything:
            // /file.tar.gz gives ext=tar.gz. The whole separator, as a lookahead: /:foo{abc:bar}
            // on /123abcabc is foo=123, bar=abc
            const colon = groupContent.indexOf(":");
            const separator = lastTokenWasParam && colon > 0 ? groupContent.slice(0, colon) : "";
            const escapedSeparator = separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const groupParamClass =
                separator === ""
                    ? "[^/]+"
                    : separator.length === 1
                      ? `[^/${escapedSeparator}]+|${escapedSeparator}`
                      : `(?:(?!${escapedSeparator})[^/])+|${escapedSeparator}`;

            let groupRegex = "";
            let gi = 0;
            while (gi < groupContent.length) {
                if (groupContent[gi] === ":") {
                    const inner = readParamName(groupContent, gi + 1);
                    const paramName = inner.name;
                    gi = inner.next;
                    groupRegex += `(?<${uniqueGroupName(paramName)}>${groupParamClass})`;
                } else if (groupContent[gi] === ".") {
                    groupRegex += "\\.";
                    gi++;
                } else if (groupContent[gi] === "/") {
                    groupRegex += "/";
                    gi++;
                } else {
                    groupRegex += groupContent[gi].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    gi++;
                }
            }
            if (lastWildcard && lastWildcardEnd === regexPattern.length) {
                // a wildcard right before the group: greedy, `(?<w>[^]+)(?:group)?` never lets the
                // group match, and lazy it loses the empty last segment of /a/b/. path-to-regexp
                // writes the two branches out, group first
                const second = uniqueGroupName(lastWildcard.name);
                wildcardNames.push(second);
                const withWildcard = regexPattern.slice(lastWildcard.start);
                regexPattern =
                    regexPattern.slice(0, lastWildcard.start) +
                    `(?:${withWildcard}${groupRegex}|(?<${second}>${lastWildcard.body}))`;
            } else {
                regexPattern += `(?:${groupRegex})?`;
            }
            literal(groupContent);
            lastTokenWasParam = false;
            continue;
        }

        if (ch === ":") {
            const named = readParamName(pattern, i + 1);
            const name = named.name;
            i = named.next;
            if (!name) {
                throw new Error(
                    `Missing parameter name at index ${i}: ${pattern}; visit https://git.new/pathToRegexpError for info`
                );
            }
            const paramGroup = uniqueGroupName(name);
            // how much of its segment a parameter may take: alone everything up to the slash, next
            // to a wildcard up to the text between them, a second parameter may also be exactly
            // that text (the alternative)
            let head;
            let alternative = "";
            if (wildcardInSegment) {
                head = negate("/", backtrack);
            } else if (wildcardLaterInSegment(i)) {
                head = negate("/", textAfter(i));
            } else if (paramInSegment) {
                head = negate("/", backtrack);
                alternative = "|" + escapeRe(backtrack);
            } else {
                head = "[^/]";
            }
            // a following optional group needs room to match, so the parameter gives ground
            const lazy = i < len && pattern[i] === "{" ? "?" : "";
            regexPattern += `(?<${paramGroup}>${head}+${lazy}${alternative})`;
            noteParam();
            continue;
        }

        // refused as path-to-regexp refuses them; escape them to use them as literals
        if ("?+()[]!}".includes(ch)) {
            throw new Error(`Unexpected ${ch} at index ${i}: ${pattern}`);
        }

        if (".^$|".includes(ch)) {
            regexPattern += "\\" + ch;
        } else {
            regexPattern += ch;
        }
        literal(ch);
        lastTokenWasParam = false;
        i++;
    }

    // non-strict allows one trailing slash in the pattern, as express; a mount ends at a segment
    // boundary and the slash belongs to what follows
    const ending = isPrefix ? "(?=$|/)" : strict ? "$" : "/?$";
    const regex = /** @type {PathRegExp} */ (new RegExp(`^${regexPattern}${ending}`, caseSensitive ? "" : "i"));
    // read back out of the finished pattern, so the list cannot disagree with it; asking each name
    // beats a for-in over match.groups, 176ns against 349
    const paramNames = [...regexPattern.matchAll(NAMED_GROUP)].map((m) => m[1]);
    patternMeta.set(regex, {
        wildcardNames,
        paramNames,
        outputNames: paramNames.map((name) => groupOutputName.get(name) ?? name),
        isWildcard: paramNames.map((name) => wildcardNames.includes(name))
    });
    return regex;
}

/**
 * Escapes a literal so patternToRegex compiles it to itself: the piece of path a RegExp mount
 * matched goes through the same join as the others.
 *
 * @param {string} literal
 * @returns {string}
 */
function escapePathLiteral(literal) {
    return literal.replace(/[:*{}?+()[\]!.^$|\\]/g, "\\$&");
}

// everything path-to-regexp gives a meaning to; a dot or a dash is not in it
const PATH_SYNTAX = /[:*{}?+()[\]!\\]/;

/**
 * Whether a path has anything a string comparison cannot answer: a parameter, a wildcard, an
 * optional group, a reserved character or an escape. "/\\(a\\)" compared as text looked for the
 * backslashes on the wire, and a bare "/(a)" has to reach the compiler, which refuses it as express.
 *
 * @param {string|RegExp} pattern
 * @returns {boolean}
 */
function needsConversionToRegex(pattern) {
    if (pattern instanceof RegExp) {
        return false;
    }

    return PATH_SYNTAX.test(pattern);
}

/**
 * Whether a path is a plain literal, eligible for the native uWS router. A RegExp answers false
 * here and to needsConversionToRegex both.
 *
 * @param {string|RegExp} pattern
 * @returns {boolean}
 */
function canBeOptimized(pattern) {
    if (pattern instanceof RegExp) {
        return false;
    }
    return !pattern.includes("*") && !pattern.includes("{") && !pattern.includes(":");
}

// a parameter that is the whole segment: "/flights/:from-:to" is two parameters to Express, one
// segment to µWS
const WHOLE_SEGMENT_PARAM = /^:[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;

/**
 * Whether µWS's router matches this path as Express would: `:name` as a whole segment only, no
 * wildcard, no optional group.
 *
 * @param {string|RegExp} pattern
 * @returns {boolean}
 */
function canBeOptimizedWithParams(pattern) {
    if (pattern instanceof RegExp) {
        return false;
    }
    if (/[*{}()[\]?+\\]/.test(pattern)) {
        return false;
    }
    if (!pattern.includes(":")) {
        return true;
    }
    for (const segment of pattern.split("/")) {
        if (segment.includes(":") && !WHOLE_SEGMENT_PARAM.test(segment)) {
            return false;
        }
    }
    return true;
}

// a segment that is not the text it is written as: only two plain literals can prove two paths never meet
const NOT_A_LITERAL = /[:*{}\\]/;

/**
 * Whether two paths could both match the same request, structurally: no position where two
 * different literals meet, and the same segment count when neither can change length.
 * `/orders/:id` and `/invoices/:id` cannot, `/users/:id` and `/users/me` can. "Do not know" is
 * yes: a wrong yes costs a native registration, a wrong no lets uWS answer an earlier route's
 * request. A wildcard and an optional group match more than themselves too.
 *
 * @param {string} a
 * @param {string} b
 * @param {boolean} [aIsPrefix] a is a mount path, so only b's leading segments are compared
 * @returns {boolean}
 */
function pathsCanOverlap(a, b, aIsPrefix = false) {
    const left = a.split("/");
    const right = b.split("/");
    // an optional group or a wildcard matches more than one length
    const fixedLength =
        a.indexOf("{") === -1 && b.indexOf("{") === -1 && a.indexOf("*") === -1 && b.indexOf("*") === -1;
    if (fixedLength && (aIsPrefix ? left.length > right.length : left.length !== right.length)) {
        return false;
    }
    const shared = left.length < right.length ? left.length : right.length;
    for (let i = 0; i < shared; i++) {
        if (left[i] === right[i]) {
            continue;
        }
        if (NOT_A_LITERAL.test(left[i]) || NOT_A_LITERAL.test(right[i])) {
            continue;
        }
        return false;
    }
    return true;
}

// a capture group opening, the expression express scans a user RegExp with
const MATCHING_GROUP_REGEXP = /\((?:\?<(.*?)>)?(?!\?)/g;

/** @type {WeakMap<RegExp, (string|number)[]>} */
const groupKeysCache = new WeakMap();

/**
 * What each capture group of a user RegExp is called in req.params: its name, or its position
 * among the unnamed ones from zero. Once per pattern.
 *
 * @param {RegExp} pattern
 * @returns {(string|number)[]} one entry per capture group, in source order
 */
function regexpGroupKeys(pattern) {
    let keys = groupKeysCache.get(pattern);
    if (keys) {
        return keys;
    }
    keys = [];
    let unnamed = 0;
    let match;
    MATCHING_GROUP_REGEXP.lastIndex = 0;
    while ((match = MATCHING_GROUP_REGEXP.exec(pattern.source)) !== null) {
        keys.push(match[1] || unnamed++);
    }
    groupKeysCache.set(pattern, keys);
    return keys;
}

/**
 * Whether µWS answers with `earlier` every path both match, so its specificity agrees with
 * express's order: yes only where the two part with the literal on the left. `/users/me` before
 * `/users/:id` is safe, `/differ/:user/bob` before `/differ/foo/:user` is not.
 *
 * @param {string} earlier
 * @param {string} later
 * @returns {boolean}
 */
function uwsPrefersEarlier(earlier, later) {
    const left = earlier.split("/");
    const right = later.split("/");
    if (left.length !== right.length) {
        return false;
    }
    for (let i = 0; i < left.length; i++) {
        if (left[i] === right[i]) {
            continue;
        }
        if (left[i].charCodeAt(0) === 0x3a || right[i].charCodeAt(0) !== 0x3a) {
            return false;
        }
    }
    return true;
}

/**
 * One entry of an Accept-style header split into value, quality and the other parameters.
 *
 * @param {string} str a single entry, such as "text/html;q=0.8;level=1"
 * @returns {{value: string, quality: number, params: Record<string, string>}}
 */
function acceptParams(str) {
    const length = str.length;
    const colonIndex = str.indexOf(";");
    let index = colonIndex === -1 ? length : colonIndex;
    const params = /** @type {Record<string, string>} */ ({});
    const ret = { value: str.slice(0, index).trim(), quality: 1, params };

    while (index < length) {
        const splitIndex = str.indexOf("=", index);
        if (splitIndex === -1) break;

        const colonIndex = str.indexOf(";", index);
        const endIndex = colonIndex === -1 ? length : colonIndex;

        if (splitIndex > endIndex) {
            index = str.lastIndexOf(";", splitIndex - 1) + 1;
            continue;
        }

        const key = str.slice(index, splitIndex).trim();
        const value = str.slice(splitIndex + 1, endIndex).trim();

        if (key === "q") {
            ret.quality = parseFloat(value);
        } else {
            ret.params[key] = value;
        }

        index = endIndex + 1;
    }

    return ret;
}

// how many answers a memo keeps before it starts over: an application uses a handful of media
// types, but res.type() may be handed what a client sent, and an unbounded map is a leak
const MEMO_LIMIT = 512;

/**
 * A pure function of one string with its answers kept. It must never answer undefined, which
 * reads as a miss; the mime lookups answer false.
 *
 * @template T
 * @param {(key: string) => T} fn
 * @returns {(key: string) => T}
 */
function memoizeByString(fn) {
    const cache = new Map();
    return function memoized(key) {
        let hit = cache.get(key);
        if (hit === undefined) {
            hit = fn(key);
            if (cache.size >= MEMO_LIMIT) {
                cache.clear();
            }
            cache.set(key, hit);
        }
        return hit;
    };
}

// mime.lookup is 273ns for the same "json" on every response, memoised 6
const lookupType = memoizeByString((type) => mime.lookup(type) || "application/octet-stream");

/**
 * The full content-type an extension stands for, charset included, as res.type() writes it.
 * @param {string} type an extension, or a media type, which is returned as given
 * @returns {string}
 */
const contentTypeFor = memoizeByString((type) => mime.contentType(type) || "application/octet-stream");

/**
 * The content-type res.set stores, as express stores it: an extension resolved with its charset,
 * false when it resolves to nothing so send() and json() write their own.
 *
 * @param {string} value
 * @returns {string|false}
 */
const contentTypeSet = memoizeByString((value) => mime.contentType(value));

/**
 * A media type from an extension or a full type with its parameters. A fresh object each time,
 * the caller may write into params.
 *
 * @param {string} type
 * @returns {{value: string, params: Record<string, string>}}
 */
function normalizeType(type) {
    return ~type.indexOf("/") ? acceptParams(type) : { value: lookupType(type), params: {} };
}

/**
 * JSON.stringify plus the "json escape" setting: <, > and & as unicode escapes.
 *
 * @param {unknown} value whatever the handler passed to res.json
 * @param {any} [replacer] the "json replacer" setting
 * @param {string|number} [spaces] the "json spaces" setting
 * @param {boolean} [escape] the "json escape" setting
 * @returns {string}
 */
function stringify(value, replacer, spaces, escape) {
    let json = replacer || spaces ? JSON.stringify(value, replacer, spaces) : JSON.stringify(value);

    if (escape && typeof json === "string") {
        json = json.replace(/[<>&]/g, function (c) {
            switch (c.charCodeAt(0)) {
                case 0x3c:
                    return "\\u003c";
                case 0x3e:
                    return "\\u003e";
                case 0x26:
                    return "\\u0026";
                default:
                    return c;
            }
        });
    }

    return json;
}

// what negotiateEncoding may answer with, a caller only offers what it can produce
const ENCODING_BR = 1;
const ENCODING_GZIP = 2;
const ENCODING_DEFLATE = 4;
const ENCODING_ZSTD = 8;
const ENCODING_ANY = ENCODING_BR | ENCODING_GZIP | ENCODING_DEFLATE | ENCODING_ZSTD;

/**
 * The encoding to answer with, scanned off Accept-Encoding: a Negotiator per response costs more
 * than the scan. The tie-break is negotiator's for the compression module's list, brotli, gzip,
 * deflate, identity last. Only the encodings in `allowed` are on offer, express.static offers the
 * two it can have on disk; uncompressed is always on offer and what an empty header chooses.
 *
 * @param {string} accept the header, or "" when the request carried none
 * @param {number} allowed ENCODING_BR, ENCODING_ZSTD, ENCODING_GZIP and ENCODING_DEFLATE, or'd
 *   together
 * @returns {string} "br", "zstd", "gzip", "deflate", "identity", or "" when nothing is
 *   acceptable
 */
function negotiateEncoding(accept, allowed) {
    // -1 while a name has not appeared: q=0 is a refusal, not silence
    let br = -1;
    let zstd = -1;
    let gzip = -1;
    let deflate = -1;
    let identity = -1;
    let star = -1;
    // the lowest q named, what an unnamed identity is worth, see below
    let minQuality = 1;
    let index = 0;
    while (index < accept.length) {
        let end = accept.indexOf(",", index);
        if (end === -1) {
            end = accept.length;
        }
        let semi = accept.indexOf(";", index);
        if (semi === -1 || semi > end) {
            semi = end;
        }
        const name = accept.slice(index, semi).trim().toLowerCase();
        let q = 1;
        if (semi < end) {
            const params = accept.slice(semi + 1, end);
            const at = params.indexOf("q=");
            if (at !== -1) {
                const parsed = parseFloat(params.slice(at + 2));
                // an unreadable q is a refusal, as negotiator reads it
                q = parsed === parsed ? parsed : 0;
            }
        }
        if (q < minQuality) {
            minQuality = q;
        }
        switch (name) {
            case "br":
                br = q;
                break;
            case "gzip":
                gzip = q;
                break;
            case "zstd":
                zstd = q;
                break;
            case "deflate":
                deflate = q;
                break;
            case "identity":
                identity = q;
                break;
            case "*":
                star = q;
                break;
        }
        index = end + 1;
    }
    if (br < 0) br = star;
    if (zstd < 0) zstd = star;
    if (gzip < 0) gzip = star;
    if (deflate < 0) deflate = star;
    // negotiator's rule: an unnamed identity is worth the lowest q named, so "br;q=0.5, gzip;q=0.9"
    // means gzip; a "*" names identity too
    if (identity < 0) identity = star < 0 ? minQuality : star;

    if (!(allowed & ENCODING_BR)) br = -1;
    if (!(allowed & ENCODING_ZSTD)) zstd = -1;
    if (!(allowed & ENCODING_GZIP)) gzip = -1;
    if (!(allowed & ENCODING_DEFLATE)) deflate = -1;

    let best = "";
    let bestQ = 0;
    if (br > bestQ) {
        best = "br";
        bestQ = br;
    }
    // below brotli on a tie, so a client taking both is answered as before zstd; above gzip
    if (zstd > bestQ) {
        best = "zstd";
        bestQ = zstd;
    }
    if (gzip > bestQ) {
        best = "gzip";
        bestQ = gzip;
    }
    if (deflate > bestQ) {
        best = "deflate";
        bestQ = deflate;
    }
    if (identity > bestQ) {
        best = "identity";
    }
    return best;
}

const defaultSettings = {
    "jsonp callback name": "callback",
    env: () => process.env.NODE_ENV ?? "development",
    etag: "weak",
    "etag fn": () => createETagGenerator({ weak: true }),
    "query parser": "simple",
    "query parser fn": () => parseQuery,
    "subdomain offset": 2,
    "trust proxy": false,
    views: () => path.join(process.cwd(), "views"),
    "view cache": () => process.env.NODE_ENV === "production",
    // off, unlike Express: every hardening guide says to remove it
    "x-powered-by": false,
    // fulmine's own: small files served by sendFile come from a bounded cache checked against the
    // file's stat per request, see Application#readSmallFile
    "file cache": true,
    // "case sensitive routing" is absent: unset means insensitive, as in Express 5
    "declarative responses": true,
    // off: on, res.send(req.query.q) and res.send(req.params.id) compile too, written by uWS as it
    // reads them (first value or nothing, undecoded, a 400 answered)
    "declarative request values": false,
    // off hands every request to the ordinary chain, slower and answering the same, so one
    // application can be served both ways and compared: `npm run fuzz -- --self`
    "native routes": true,
    // a window in which a file's size and mtime are remembered, one syscall less per request
    "stat cache": false,
    "stat cache ms": 0,
    // a security setting: on, req.ip is what a PROXY protocol preamble declared, and µWS reads
    // that from any client. Only behind the proxy, see Request#_readRawIp
    "trust proxy protocol": false,
    // Express sends both on every response; off, only a closing connection says so
    "connection headers": true
};

// moved by Application#set and by a mount on any app, so every resolved copy goes stale at once,
// see Router#_hot
const settingsEpoch = { n: 1 };

// a file's stat for as long as "stat cache" says, the trade nginx's open_file_cache makes
const statCache = new Map();
const STAT_CACHE_LIMIT = 4096;

/**
 * The stat of a path, from the cache while the window holds. A failure is never remembered.
 *
 * @param {string} file
 * @param {number} ttl milliseconds an answer stays good, 0 to ask the disk every time
 * @returns {import("fs").Stats}
 */
function cachedStat(file, ttl) {
    if (ttl <= 0) {
        return fs.statSync(file);
    }
    const now = Date.now();
    const known = statCache.get(file);
    if (known !== undefined && known.until > now) {
        return known.stat;
    }
    const stat = fs.statSync(file);
    if (statCache.size >= STAT_CACHE_LIMIT) {
        statCache.clear();
    }
    statCache.set(file, { stat, until: now + ttl });
    return stat;
}

/**
 * A duration setting as milliseconds: false is off, a string is read by ms, a number is itself.
 *
 * @param {string|number|boolean|undefined} value the setting as the application wrote it
 * @param {string} name for the error, which names the setting the application wrote
 * @returns {number}
 */
function durationSetting(value, name) {
    const parsed =
        value === false || value === undefined
            ? 0
            : typeof value === "string"
              ? ms(/** @type {import("ms").StringValue} */ (value))
              : value;
    if (typeof parsed !== "number" || !(parsed >= 0)) {
        throw new TypeError(`${name} must be a duration`);
    }
    return parsed;
}

/**
 * The predicate "trust proxy" compiles to: whether the address at hop i is trusted. The address is
 * undefined over a unix socket, see Request#parsedIp.
 *
 * @typedef {(addr: string|undefined, i: number) => boolean} TrustFn
 */

/**
 * "trust proxy" as the predicate proxy-addr wants: true trusts everything, a number that many
 * hops, a string or a list is addresses and subnet names.
 *
 * @param {boolean|number|string|string[]|TrustFn} val
 * @returns {TrustFn}
 */
function compileTrust(val) {
    if (typeof val === "function") return val;

    if (val === true) {
        return function () {
            return true;
        };
    }

    if (typeof val === "number") {
        const hops = val;
        return function (/** @type {string|undefined} */ a, /** @type {number} */ i) {
            return i < hops;
        };
    }

    if (typeof val === "string") {
        val = val.split(",").map(function (v) {
            return v.trim();
        });
    }

    // proxy-addr answers false to undefined, though its typing does not admit one
    return /** @type {TrustFn} */ (proxyaddr.compile(val || []));
}

const shownWarnings = new Set();
/**
 * Warns once per call site that a method has a newer name, in the deprecate package's format.
 *
 * @param {string} oldMethod
 * @param {string} newMethod
 * @param {boolean} [full] print the whole stack rather than the one frame that called it
 */
function deprecated(oldMethod, newMethod, full = false) {
    const err = new Error();
    const stack = err.stack ?? "";
    const pos = full
        ? stack.split("\n").slice(1).join("\n")
        : stack.split("\n")[3].trim().split("(").slice(1).join("(").split(")").slice(0, -1).join(")");
    if (shownWarnings.has(pos)) return;
    shownWarnings.add(pos);
    console.warn(
        `${new Date().toLocaleString("en-UK", {
            weekday: "short",
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
            second: "numeric",
            timeZone: "GMT",
            timeZoneName: "short"
        })} fulmine.js deprecated ${oldMethod}: Use ${newMethod} instead at ${pos}`
    );
}

/**
 * findIndex resuming from a position, for the router picking up after the route it just ran.
 *
 * @template T
 * @param {T[]} arr
 * @param {(item: T, index: number, arr: T[]) => boolean} fn
 * @param {number} [index] where to start
 * @returns {number} the index, or -1
 */
function findIndexStartingFrom(arr, fn, index = 0) {
    for (let i = index, end = arr.length; i < end; i++) {
        if (fn(arr[i], i, arr)) {
            return i;
        }
    }
    return -1;
}

/**
 * decodeURIComponent answering -1 instead of throwing, for the callers that answer 400.
 *
 * @param {string} path
 * @returns {string|-1} -1 when the path cannot be decoded
 */
function decode(path) {
    try {
        return decodeURIComponent(path);
    } catch (err) {
        return -1;
    }
}

/**
 * A route parameter decoded, `caff%C3%A8` as "caffè"; one that will not decode is a 400 with
 * Express's message.
 *
 * @param {string} value
 * @returns {string}
 * @throws {HttpError} status 400
 */
function decodeParam(value) {
    // a parameter is usually a number or a word, and decodeURIComponent is not free
    if (value.indexOf("%") === -1) {
        return value;
    }
    try {
        return decodeURIComponent(value);
    } catch {
        // a URIError as express throws it, for a handler written as `err instanceof URIError`
        /** @type {HttpError} */
        const err = new URIError(`Failed to decode param '${value}'`);
        err.status = 400;
        err.statusCode = 400;
        err.expose = true;
        throw err;
    }
}

const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Whether any segment is a dotfile; a single "." is the current directory.
 *
 * @param {string[]} parts the path split on slashes
 * @returns {boolean}
 */
function containsDotFile(parts) {
    for (let i = 0, len = parts.length; i < len; i++) {
        const part = parts[i];
        if (part.length > 1 && part[0] === ".") {
            return true;
        }
    }

    return false;
}

/**
 * A comma-separated header value as its tokens, trimmed; by hand, it runs per conditional request.
 *
 * @param {string} str
 * @returns {string[]}
 */
function parseTokenList(str) {
    let end = 0;
    const list = [];
    let start = 0;

    for (let i = 0, len = str.length; i < len; i++) {
        switch (str.charCodeAt(i)) {
            case 0x20 /*   */:
                if (start === end) {
                    start = end = i + 1;
                }
                break;
            case 0x2c /* , */:
                if (start !== end) {
                    list.push(str.substring(start, end));
                }
                start = end = i + 1;
                break;
            default:
                end = i + 1;
                break;
        }
    }

    if (start !== end) {
        list.push(str.substring(start, end));
    }

    return list;
}

/**
 * An HTTP date as a timestamp, NaN when missing or unreadable so every comparison is false.
 *
 * @param {string|undefined} date
 * @returns {number}
 */
function parseHttpDate(date) {
    const timestamp = date && Date.parse(date);
    return typeof timestamp === "number" ? timestamp : NaN;
}

/**
 * Whether If-Match or If-Unmodified-Since says the client's copy is no longer current, a 412.
 *
 * @param {Request} req
 * @param {Response} res
 * @returns {boolean}
 */
function isPreconditionFailure(req, res) {
    const match = req.headers["if-match"];

    if (match) {
        const etag = res.get("etag");
        return (
            !etag ||
            (match !== "*" &&
                parseTokenList(match).every((match) => {
                    return match !== etag && match !== "W/" + etag && "W/" + match !== etag;
                }))
        );
    }

    const unmodifiedSince = parseHttpDate(req.headers["if-unmodified-since"]);
    if (!isNaN(unmodifiedSince)) {
        const lastModified = parseHttpDate(/** @type {string|undefined} */ (res.get("Last-Modified")));
        return isNaN(lastModified) || lastModified > unmodifiedSince;
    }

    return false;
}

// the sha1 of nothing, as the etag package answers without hashing
const EMPTY_ENTITY_TAG = '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';

/**
 * The ETag of a body as the etag package writes it: length in hex, a dash, 27 characters of the
 * base64 sha1. crypto.hash, not createHash: 924ns against 1963 on a 500 byte body.
 *
 * @param {Buffer|string} entity
 * @param {boolean} weak
 * @returns {string}
 */
function entityTag(entity, weak) {
    if (entity.length === 0) {
        return weak ? "W/" + EMPTY_ENTITY_TAG : EMPTY_ENTITY_TAG;
    }
    const len = typeof entity === "string" ? Buffer.byteLength(entity, "utf8") : entity.length;
    const tag = `"${len.toString(16)}-${crypto.hash("sha1", entity, "base64").substring(0, 27)}"`;
    return weak ? "W/" + tag : tag;
}

/**
 * The ETag of a file from its size and mtime, as send computes it.
 *
 * @param {import("fs").Stats} stat
 * @param {boolean} weak
 * @returns {string}
 */
function statTag(stat, weak) {
    const tag = `"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;
    return weak ? "W/" + tag : tag;
}

/**
 * The function the "etag" setting installs, taking a body or an fs.Stats.
 *
 * @param {{weak: boolean}} options
 * @returns {(body: string|Buffer|import("fs").Stats, encoding?: BufferEncoding) => string}
 */
function createETagGenerator(options) {
    return function generateETag(body, encoding) {
        if (body instanceof Stats) {
            return statTag(body, options.weak);
        }
        // crypto.hash reads a string as its utf8 bytes, no copy first
        if (typeof body === "string" && (encoding === undefined || encoding === "utf8" || encoding === "utf-8")) {
            return entityTag(body, options.weak);
        }
        const buf = !Buffer.isBuffer(body) ? Buffer.from(body, encoding) : body;
        return entityTag(buf, options.weak);
    };
}

/**
 * Whether an If-Range, an ETag or a date, still holds; otherwise the whole file goes.
 *
 * @param {Request} req
 * @param {Response} res
 * @returns {boolean}
 */
function isRangeFresh(req, res) {
    const ifRange = /** @type {string|undefined} */ (req.headers["if-range"]);
    if (!ifRange) {
        return true;
    }

    if (ifRange.indexOf('"') !== -1) {
        const etag = /** @type {string|undefined} */ (res.get("etag"));
        return Boolean(etag && ifRange.indexOf(etag) !== -1);
    }

    const lastModified = /** @type {string|undefined} */ (res.get("Last-Modified"));
    return parseHttpDate(lastModified) <= parseHttpDate(ifRange);
}

/**
 * Escapes the five markup characters, as a scan: it runs on every error page and redirect body.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    const s = String(str);
    const len = s.length;
    let i = 0;

    for (; i < len; i++) {
        const ch = s.charCodeAt(i);
        if (ch === 0x26 || ch === 0x3c || ch === 0x3e || ch === 0x22 || ch === 0x27) {
            break;
        }
    }

    if (i === len) return s;

    let escaped = s.substring(0, i);

    for (; i < len; i++) {
        const ch = s.charCodeAt(i);
        switch (ch) {
            case 0x26: // &
                escaped += "&amp;";
                break;
            case 0x3c: // <
                escaped += "&lt;";
                break;
            case 0x3e: // >
                escaped += "&gt;";
                break;
            case 0x22: // "
                escaped += "&quot;";
                break;
            case 0x27: // '
                escaped += "&#39;";
                break;
            default:
                escaped += s.charAt(i);
                break;
        }
    }

    return escaped;
}

const CHARSET_PRESENT = /;\s*charset\s*=/i;
const CHARSET_PARAM = /;\s*charset\s*=\s*[^;]*/i;
const UTF8_CHARSET = "; charset=utf-8";

/**
 * The value plus the charset its media type implies. Memoised, 159ns against 7.
 *
 * @param {string} value
 * @returns {string}
 */
const withDefaultCharset = memoizeByString((value) => {
    if (CHARSET_PRESENT.test(value)) {
        return value;
    }
    const charset = mime.charset(value.split(";")[0]);
    return charset ? `${value}; charset=${charset.toLowerCase()}` : value;
});

/**
 * The same content-type saying utf-8, which is how a string body goes out; Express replaces it too.
 *
 * @param {string} value
 * @returns {string}
 */
function withUtf8Charset(value) {
    // almost every string body already carries this exact form, the regexes below were 2% of a request
    if (value.endsWith(UTF8_CHARSET)) {
        return value;
    }
    return CHARSET_PARAM.test(value) ? value.replace(CHARSET_PARAM, UTF8_CHARSET) : `${value}${UTF8_CHARSET}`;
}

// what node lets a header name and value hold. uWS writes `key: value\r\n` with no check of its
// own, so a CR or LF that reaches it is a header injection
const HEADER_TOKEN = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const HEADER_VALUE = /[^\t\x20-\x7e\x80-\xff]/;

/**
 * One of node's header errors as node builds it: the code goes into the stack's first line by
 * naming the error "TypeError [THE_CODE]" while V8 formats it, then the name comes back off. The
 * error page prints that line. Found by fuzzing.
 *
 * @param {string} message
 * @param {string} code
 * @returns {NodeJS.ErrnoException}
 */
function headerError(message, code) {
    /** @type {NodeJS.ErrnoException} */
    const err = new TypeError(message);
    err.name = `TypeError [${code}]`;
    void err.stack;
    delete (/** @type {{name?: string}} */ (err).name);
    err.code = code;
    return err;
}

/**
 * node's ERR_HTTP_HEADERS_SENT: "set" from setHeader, "remove" from removeHeader, "write" from writeHead.
 *
 * @param {string} verb
 * @returns {NodeJS.ErrnoException}
 */
function headersSentError(verb) {
    /** @type {NodeJS.ErrnoException} */
    const err = new Error(`Cannot ${verb} headers after they are sent to the client`);
    // see headerError
    err.name = "Error [ERR_HTTP_HEADERS_SENT]";
    void err.stack;
    delete (/** @type {{name?: string}} */ (err).name);
    err.code = "ERR_HTTP_HEADERS_SENT";
    return err;
}

/**
 * Applies the headers a writeHead call carries, in either of node's shapes, and answers the
 * reason phrase. Shared with the middleware hooking writeHead, as on-headers applies them first.
 *
 * @param {{setHeader(name: string, value: import("http").OutgoingHttpHeader|undefined): unknown}} res
 * @param {string|import("http").OutgoingHttpHeaders|import("http").OutgoingHttpHeader[]} [statusMessage]
 * @param {import("http").OutgoingHttpHeaders|import("http").OutgoingHttpHeader[]} [headers]
 * @returns {string|undefined} the reason phrase
 */
function applyWriteHead(res, statusMessage, headers) {
    let reason;
    if (typeof statusMessage === "string") {
        reason = statusMessage;
    } else if (!headers) {
        headers = statusMessage;
    }
    if (Array.isArray(headers)) {
        // a flat list, name then value, as node takes it
        if (headers.length % 2 !== 0) {
            /** @type {NodeJS.ErrnoException} */
            const err = new TypeError(`The argument 'headers' is invalid. Received ${JSON.stringify(headers)}`);
            err.code = "ERR_INVALID_ARG_VALUE";
            throw err;
        }
        for (let i = 0; i < headers.length; i += 2) {
            res.setHeader(/** @type {string} */ (headers[i]), headers[i + 1]);
        }
    } else if (headers) {
        for (const header in headers) {
            res.setHeader(header, headers[header]);
        }
    }
    return reason;
}

/**
 * Refuses a header name that is not an HTTP token, with node's error.
 *
 * @param {unknown} name whatever a caller passed
 * @returns {void}
 * @throws {TypeError} ERR_INVALID_HTTP_TOKEN
 */
function validateHeaderName(name) {
    if (typeof name !== "string" || !HEADER_TOKEN.test(name)) {
        throw headerError(`Header name must be a valid HTTP token ["${name}"]`, "ERR_INVALID_HTTP_TOKEN");
    }
}

// values already accepted, so helmet's constant strings skip the scan; bounded, set-cookie stays out
const KNOWN_HEADER_VALUES = new Set();

/**
 * Refuses a header value holding a character that cannot go on the wire, with node's error; an
 * array entry by entry.
 *
 * @param {string} name
 * @param {string|string[]} value already coerced to text
 * @returns {void}
 * @throws {TypeError} ERR_INVALID_CHAR
 */
function validateHeaderValue(name, value) {
    if (Array.isArray(value)) {
        for (const one of value) {
            validateHeaderValue(name, one);
        }
        return;
    }
    if (KNOWN_HEADER_VALUES.has(value)) {
        return;
    }
    if (HEADER_VALUE.test(value)) {
        throw headerError(`Invalid character in header content ["${name}"]`, "ERR_INVALID_CHAR");
    }
    if (
        KNOWN_HEADER_VALUES.size < 512 &&
        value.length <= 1024 &&
        !(name.length === 10 && name.toLowerCase() === "set-cookie")
    ) {
        KNOWN_HEADER_VALUES.add(value);
    }
}

/**
 * Whether this pair could go on the wire, for the error path where a throw has nobody to catch it.
 *
 * @param {string} name
 * @param {any} value whatever a caller passed as a header value
 * @returns {boolean}
 */
function headerIsWritable(name, value) {
    if (!HEADER_TOKEN.test(name)) {
        return false;
    }
    return Array.isArray(value) ? value.every((one) => !HEADER_VALUE.test(one)) : !HEADER_VALUE.test(value);
}

// the status send picks for a failed stat; anything else is the server's 500
const STAT_ERROR_STATUS = { ENAMETOOLONG: 404, ENOTDIR: 404, ENOENT: 404 };

/**
 * The error send and serve-static refuse with, http-errors' shape: `status`, `statusCode`,
 * `expose`, and the status text as the message.
 *
 * @param {number} status
 * @param {string} [message] the status text unless given, as http-errors has it
 * @returns {HttpError}
 */
function httpError(status, message = statuses.message[status] ?? "Error") {
    /** @type {HttpError} */
    const err = new Error(message);
    // http-errors' name, BadRequestError and so on, is what the error page shows. Before the
    // stack is read, V8 formats it then
    err.name = httpErrorName(status);
    err.expose = status < 500;
    err.statusCode = status;
    err.status = status;
    return err;
}

/**
 * http-errors' name for a status, NotFoundError for 404: the status text run together, plus Error
 * unless it already ends in it.
 *
 * @param {number} status
 * @returns {string}
 */
function httpErrorName(status) {
    const name = (statuses.message[status] ?? "Error")
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join("")
        .replace(/[^ _0-9a-z]/gi, "");
    return name.endsWith("Error") ? name : name + "Error";
}

/**
 * Marks an fs error as send does, on the error itself so errno, code, syscall and path survive.
 * The order is what res.send(err) serialises.
 *
 * @param {HttpError} err the fs error, which carries its errno and path
 * @returns {HttpError} the same error
 */
function asStatError(err) {
    err.expose = false;
    err.statusCode = STAT_ERROR_STATUS[err.code] ?? 500;
    err.status = err.statusCode;
    return err;
}

// a constructor whose instances have no prototype, so a key from a body or a query cannot reach
// Object.prototype. Typed as a plain record, `any` would reset narrowing
const NullObject = /** @type {new () => Record<string, any>} */ (/** @type {unknown} */ (function () {}));
NullObject.prototype = Object.create(null);

module.exports = {
    cachedStat,
    durationSetting,
    removeDuplicateSlashes,
    patternToRegex,
    escapePathLiteral,
    getPatternMeta,
    needsConversionToRegex,
    acceptParams,
    normalizeType,
    stringify,
    defaultSettings,
    compileTrust,
    deprecated,
    UP_PATH_REGEXP,
    NullObject,
    decode,
    decodeParam,
    containsDotFile,
    parseTokenList,
    parseHttpDate,
    isPreconditionFailure,
    createETagGenerator,
    entityTag,
    statTag,
    contentTypeFor,
    contentTypeSet,
    negotiateEncoding,
    ENCODING_BR,
    ENCODING_GZIP,
    ENCODING_DEFLATE,
    ENCODING_ZSTD,
    ENCODING_ANY,
    memoizeByString,
    isRangeFresh,
    findIndexStartingFrom,
    fastQueryParse,
    canBeOptimized,
    canBeOptimizedWithParams,
    pathsCanOverlap,
    uwsPrefersEarlier,
    regexpGroupKeys,
    escapeHtml,
    validateHeaderName,
    validateHeaderValue,
    headerIsWritable,
    withDefaultCharset,
    withUtf8Charset,
    asStatError,
    httpError,
    httpErrorName,
    headersSentError,
    applyWriteHead,
    EMPTY_REGEX,
    settingsEpoch
};
