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

const EMPTY_REGEX = new RegExp(``);

// what express hands qs for a query string. allowPrototypes keeps a key named "constructor" or
// "toString" instead of dropping it, and it is safe here for the reason it is safe there: the
// result below sits on a null prototype, so such a key is inert data. A caller with options of its
// own, the extended body parser, passes them and does not get these.
const QUERY_QS_OPTIONS = { allowPrototypes: true };

/**
 * Parses a query string the way the "extended" parser is expected to, which means qs and its
 * support for nested keys, but without paying for qs on the strings that cannot need it. A short
 * query with no bracket and no dot goes through fast-querystring instead, which is several times
 * quicker and produces the same answer for that shape.
 *
 * @param {string} query the query string, without the leading "?"
 * @param {object} [options] passed through to qs when it is used
 * @returns {Record<string, any>} null-prototype, so a key from the query cannot reach Object.prototype
 */
function fastQueryParse(query, options) {
    // the result keeps a null prototype, which is why req.query prints as "[Object: null
    // prototype] {}". Spreading it into a plain object would put Object.prototype keys back
    // within reach of a query string.
    const len = query.length;
    if (len === 0) {
        return Object.create(null);
    }
    if (len <= 128) {
        // An empty name is the other place the two disagree: "=v" and "a=1&=2" are a pair under
        // the empty key to fast-querystring, and nothing at all to qs. A query carrying one goes
        // the slow way, which is what makes the shortcut above safe to take for the rest.
        if (
            !query.includes("[") &&
            !query.includes("%5B") &&
            !query.includes(".") &&
            !query.includes("%2E") &&
            query.charCodeAt(0) !== 0x3d &&
            !query.includes("&=")
        ) {
            // already on a bare null prototype, no copy needed, see parse-query.js
            const parsed = parseQuery(query);
            // qs drops a "__proto__" key whatever allowPrototypes says, and a null prototype makes
            // this one an ordinary own property rather than the setter, so reading it is a plain
            // load and the encoded spelling is covered too: the name is decoded before it lands
            if (parsed.__proto__ !== undefined) {
                delete parsed.__proto__;
            }
            return parsed;
        }
    }
    return Object.assign(Object.create(null), qs.parse(query, options ?? QUERY_QS_OPTIONS));
}

/**
 * Collapses runs of slashes, so //a///b reads as /a/b. Express does the same before matching, and
 * without it a path could dodge a route by being written with an extra slash.
 *
 * @param {string} path
 * @returns {string}
 */
function removeDuplicateSlashes(path) {
    return path.replace(/\/{2,}/g, "/");
}

// What path-to-regexp takes as a parameter name, which is a javascript identifier: /:café and
// /:año are names to express and were a dead route here, because \w stops at ASCII. A named
// capture group accepts the same spellings, so the compiled pattern still carries the name.
const ID_START = /[$_\p{ID_Start}]/u;
// the two joiners are written as escapes on purpose: as themselves they are invisible here
const ID_CONTINUE = /[$\u200c\u200d\p{ID_Continue}]/u;

/**
 * Reads a parameter name out of a pattern. Walks code points rather than code units, so a name
 * starting outside the basic plane is read whole instead of as half a surrogate pair.
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
 * A character class that matches anything except what these two strings could start, which is how
 * path-to-regexp stops a capture from backtracking over the literal text that follows it. Ported
 * from its negate(), so the patterns compiled here agree with the ones express matches.
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

// the opening of a named capture group, which is how the parameter names are read back out of a
// finished pattern
const NAMED_GROUP = /\(\?<([^>]+)>/g;

/**
 * What a compiled pattern captures: the names in order, and which of them are wildcards to split
 * into an array. Here and not on the regex itself, because one own property takes a RegExp off V8's
 * fast path: replace() went from 37ns to 808ns and test() from 22ns to 78ns.
 *
 * @typedef {{wildcardNames: string[], paramNames: string[], outputNames: string[], isWildcard: boolean[]}} PatternMeta
 */
const patternMeta = new WeakMap();

/**
 * What patternToRegex worked out about a pattern, or undefined for a RegExp the application wrote
 * itself.
 * @param {RegExp} pattern
 * @returns {PatternMeta|undefined}
 */
function getPatternMeta(pattern) {
    return patternMeta.get(pattern);
}

/**
 * A compiled path pattern. A plain RegExp, deliberately.
 * @typedef {RegExp} PathRegExp
 */

/**
 * Compiles a path into a regex, following path-to-regexp v8:
 *   - :param          a named parameter, one segment
 *   - /*splat         a named wildcard, one or more segments, captured as an array
 *   - {...}           an optional group
 *   - \x              an escaped literal
 *
 * A bare `*`, an unnamed parameter, an inline regex like :id(\\d+) and the `+`, `?`, `()` operators
 * throw: a route that quietly stops matching is worse than one that fails at startup. The names it
 * captures go in a WeakMap beside the regex, see PatternMeta.
 */
function patternToRegex(pattern, isPrefix = false, caseSensitive = true, strict = false) {
    if (pattern instanceof RegExp) {
        // the application's own RegExp matches as written, whatever the routing setting says,
        // which is what express does with one
        return pattern;
    }
    if (isPrefix && pattern === "") {
        return EMPTY_REGEX;
    }

    let regexPattern = "";
    let i = 0;
    const len = pattern.length;
    const wildcardNames = [];
    // express takes /:a/:a, and two capture groups cannot share a name, so a repeat is compiled
    // under a spelling of its own and mapped back when the parameters are read out. Reading them
    // in order then leaves the last occurrence in place, which is the value express reports
    const groupOutputName = new Map();
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
    // whether the token just emitted was a :parameter or a wildcard, which decides how greedy the
    // next optional group is allowed to be. see the comment where it is read
    let lastTokenWasParam = false;
    // the wildcard just emitted, and where it ends, so an optional group written right after it
    // can rewrite the two into one alternation. See the { branch
    let lastWildcard = /** @type {{start: number, body: string, name: string}|null} */ (null);
    let lastWildcardEnd = -1;
    // What path-to-regexp calls the wildcard backtrack: the literal text written since the last
    // wildcard. Once a wildcard has eaten slashes, a later one in the same path is held to a single
    // segment, or the two would divide the path between them in more than one way and the regex
    // would have to backtrack to find out which. /*a/*b against /x/y/ is the case that shows it:
    // express refuses it under strict routing, and a second greedy wildcard accepts it.
    // the text written since the last capture of any kind, and the text written since the last
    // wildcard, which are the two path-to-regexp weighs
    let backtrack = "";
    let wildcardBacktrack = "";
    let lastCaptureWasWildcard = false;
    let wildcardInSegment = false;
    let paramInSegment = false;
    /** Records literal text as it is emitted, which is what the rules above are written against. */
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
     * Whether a wildcard is still to come in the segment being written, which makes the parameters
     * before it give ground so that it has something left to match.
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
     * The literal text written immediately after this point, which is what the capture before it
     * must not swallow.
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
     * What a wildcard is allowed to match here, and the bookkeeping that goes with emitting one.
     * The first wildcard of a path takes everything; one sharing a segment with an earlier wildcard
     * stops at the text between them; and one in a later segment is held to a single segment.
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

        // *splat: one or more characters, slashes included. It is not anchored to a segment
        // boundary, so /te*st is literal "/te" followed by a wildcard named "st"
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
            // where this capture starts and what it is made of, so an optional group written right
            // after it can rewrite the pair into the alternation path-to-regexp compiles. See the
            // { branch below
            lastWildcard = { start: regexPattern.length, body, name };
            regexPattern += `(?<${splatGroup}>${body})`;
            lastWildcardEnd = regexPattern.length;
            // the group that follows is held to one segment of its own, the way it is after a
            // parameter: without it ext could take the separator back and swallow the dots
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
                    // the slash is part of the alternative rather than optional on its own: a
                    // mount at /a/{*w} answers /a/ and /a/x, and not /a, which is what express
                    // compiles it to
                    regexPattern = regexPattern.slice(0, regexPattern.endsWith("\\/") ? -2 : -1);
                    // under strict routing the slash is part of the alternative, so /a/{*w}
                    // answers /a/ and /a/x and not /a. Without it express loosens the pattern and
                    // allows a trailing slash instead, which is the shape the path arrives in here
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
            i++;

            // When a :parameter precedes this group, that parameter is the one that gives ground
            // while backtracking, so this one must not swallow the separator as well. Express
            // splits /a.b.c against /:file{.:ext} as file=a.b, ext=c, which only works if ext
            // cannot contain a dot. After static text there is nothing to give ground, so the
            // parameter takes everything: /file{.:ext} against /file.tar.gz gives ext=tar.gz.
            // The whole of it, not its first character: /:foo{abc:bar} against /123abcabc splits as
            // foo=123 and bar=abc on express, and reading the separator as "a" left bar unable to
            // match its own text, so the group never matched and foo took the segment whole. More
            // than one character cannot go in a class, so it is written as a lookahead, and either
            // way the parameter is still allowed to be exactly the separator, as path-to-regexp
            // writes it.
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
                // A wildcard immediately before the group. `(?<w>[^]+)(?:group)?` can never let
                // the group match, because the wildcard is greedy and the group may be empty, and
                // making the wildcard lazy is not the same thing either: it gives the trailing
                // slash away, and /*path{.:ext} against /a/b/ then loses the empty last segment.
                // path-to-regexp writes the two branches out instead, group first and the
                // wildcard greedy in both, so that is what goes here. The second branch captures
                // the same parameter under a name of its own, which is what uniqueGroupName is for.
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
            // a following optional group needs room to match, so the parameter gives ground
            const paramGroup = uniqueGroupName(name);
            // How much of its segment a parameter may take, which path-to-regexp decides by what
            // else shares the segment with it. Alone it takes everything up to the next slash; with
            // a wildcard beside it, before or after, it stops at the text that separates the two,
            // so the wildcard has something left to match; and a second parameter in the segment
            // may also be exactly that separating text, which is the alternative below.
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

        // these have no meaning in a path, and the route is refused rather than matching them
        // literally: a path that quietly stops matching is worse than one that fails at startup.
        // Escape them to use them as literals.
        if ("?+()[]!".includes(ch)) {
            throw new Error(`Unexpected ${ch} at index ${i}: ${pattern}`);
        }

        if (".^$|}".includes(ch)) {
            regexPattern += "\\" + ch;
        } else {
            regexPattern += ch;
        }
        literal(ch);
        lastTokenWasParam = false;
        i++;
    }

    // Without strict routing express allows one trailing slash at the end of the pattern
    // rather than taking it off the path, which is the only way /things and /things/ can be the
    // same route while // and /things/ stay different paths. A mount ends at a segment boundary
    // instead, and the slash after it belongs to what follows.
    const ending = isPrefix ? "(?=$|/)" : strict ? "$" : "/?$";
    const regex = /** @type {PathRegExp} */ (new RegExp(`^${regexPattern}${ending}`, caseSensitive ? "" : "i"));
    // read back out of the finished pattern, so the list cannot disagree with the regex. Asking for
    // each name in turn beats walking match.groups with for-in: 176ns against 349
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
 * Escapes a literal so patternToRegex compiles it to itself. Used for the piece of path a RegExp
 * mount matched, which is text and not a pattern, but goes through the same join as the others.
 *
 * @param {string} literal
 * @returns {string}
 */
function escapePathLiteral(literal) {
    return literal.replace(/[:*{}?+()[\]!.^$|\\]/g, "\\$&");
}

/**
 * Whether a path has anything in it that a string comparison cannot answer, which is a parameter,
 * a wildcard or an optional group. A regular expression is already compiled, so it needs nothing.
 *
 * @param {string|RegExp} pattern
 * @returns {boolean}
 */
function needsConversionToRegex(pattern) {
    if (pattern instanceof RegExp) {
        return false;
    }

    return pattern.includes("*") || pattern.includes(":") || pattern.includes("{");
}

/**
 * Whether a path is a plain literal, which is what makes a route eligible for the native uWS
 * router. Not simply the opposite of needsConversionToRegex: a RegExp answers false to both, since
 * it needs no conversion and cannot be optimized either.
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

// a parameter that is the whole segment, which is the only shape µWS matches the same way Express
// does. "/flights/:from-:to" is one segment to µWS and two parameters to Express.
const WHOLE_SEGMENT_PARAM = /^:[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u;

/**
 * Whether µWS's own router matches this path exactly as Express would, parameters included.
 *
 * µWS matches `:name` against one non-empty segment, as Express does, and has nothing for a v5
 * wildcard or an optional group. A parameter counts only when it is the whole segment: Express
 * matches `/flights/:from-:to` inside a segment and µWS does not.
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

// What makes a segment something other than the text it is written as: a parameter, a wildcard, an
// optional group, or an escape. Only two plain literals can prove that two paths never meet, so
// anything carrying one of these has to be read as "could be anything".
const NOT_A_LITERAL = /[:*{}\\]/;

/**
 * Whether two paths could both match the same request.
 *
 * The answer is structural: no position where two different literals meet, and, when neither path
 * can change length, the same number of segments. `/orders/:id` and `/invoices/:id` cannot both
 * match, `/users/:id` and `/users/me` can. The caller reads "do not know" as yes, so every doubt
 * answers true: saying two paths overlap only costs a native registration, while missing one lets
 * µWS answer a request that belonged to an earlier route.
 *
 * A parameter is not the only shape that matches more than itself. A wildcard and an optional group
 * do too, and reading `{:opt}` or `*splat` as the literal text it is written as reported "cannot
 * overlap" for a route that plainly could, which took the earlier route's turn away.
 *
 * @param {string} a
 * @param {string} b
 * @param {boolean} [aIsPrefix] a is a mount path, so only b's leading segments are compared
 * @returns {boolean}
 */
function pathsCanOverlap(a, b, aIsPrefix = false) {
    const left = a.split("/");
    const right = b.split("/");
    // An optional group matches its segment or nothing at all and a wildcard matches several, so a
    // path carrying either one matches more than one length and the count settles nothing.
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

// a capture group opening: "(" not followed by "?", or "(?<name>". The same expression express
// scans a user-supplied RegExp with, so the keys come out in the same order
const MATCHING_GROUP_REGEXP = /\((?:\?<(.*?)>)?(?!\?)/g;

/** @type {WeakMap<RegExp, (string|number)[]>} */
const groupKeysCache = new WeakMap();

/**
 * What each capture group of a user-supplied RegExp is called in req.params: its own name when it
 * has one, otherwise its position among the unnamed groups, counting from zero. Worked out once
 * per pattern, since the source never changes.
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
 * Whether µWS would answer with `earlier` every path that both paths match, which is what makes its
 * order agree with express's registration order.
 *
 * µWS ranks segment by segment and a literal beats a parameter, so the answer is yes only where the
 * two part with the literal on the left. `/users/me` before `/users/:id` is safe, `/differ/:user/bob`
 * before `/differ/foo/:user` is not: express answers the first, µWS the second.
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
 * Splits one entry of an Accept-style header into its value and its parameters, with q pulled out
 * as the quality since that is the one every caller wants.
 *
 * @param {string} str a single entry, such as "text/html;q=0.8;level=1"
 * @returns {{value: string, quality: number, params: Record<string, string>}}
 */
function acceptParams(str) {
    const length = str.length;
    const colonIndex = str.indexOf(";");
    let index = colonIndex === -1 ? length : colonIndex;
    const ret = { value: str.slice(0, index).trim(), quality: 1, params: {} };

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

// How many answers a memo keeps before it starts over.
//
// The keys are media types, so an application uses a handful and the ceiling is never approached.
// It is here because application code is free to hand res.type() something a client sent, and an
// unbounded map keyed on that is a leak the client controls.
//
// Clearing beats evicting one entry at a time: the few types an application really uses are back
// within a few requests, whereas refusing new entries once full would let a flood of invented
// values lock the real ones out for the life of the process.
const MEMO_LIMIT = 512;

/**
 * A pure function of one string, with its answers kept.
 *
 * The wrapped function must never answer undefined, since that is what the cache reads as a miss.
 * The mime lookups here answer false for something they do not know, which caches correctly.
 *
 * @param {(key: string) => any} fn
 * @returns {(key: string) => any}
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

// mime.lookup walks the extension and searches the database for it, which for the same "json" on
// every response is 273 ns to reach the same answer. Kept, it is 6.
const lookupType = memoizeByString((type) => mime.lookup(type) || "application/octet-stream");

/**
 * The full content-type an extension stands for, charset included, as res.type() writes it.
 * @param {string} type an extension, or a media type, which is returned as given
 * @returns {string}
 */
const contentTypeFor = memoizeByString((type) => mime.contentType(type) || "application/octet-stream");

/**
 * A media type from either spelling: "html" is looked up in the mime database, while anything
 * containing a slash is already one and is parsed for its parameters.
 *
 * @param {string} type an extension or a full media type
 * @returns {{value: string, params: Record<string, string>}}
 */
function normalizeType(type) {
    // a fresh object every time on purpose: the caller owns params and may write to it
    return ~type.indexOf("/") ? acceptParams(type) : { value: lookupType(type), params: {} };
}

/**
 * JSON.stringify, plus the escaping the "json escape" setting asks for: <, > and & become their
 * unicode escapes, so a string in the body cannot close a script tag in an HTML page that embeds
 * the response.
 *
 * @param {any} value
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

// What negotiateEncoding may answer with, since a caller can only offer what it can produce
const ENCODING_BR = 1;
const ENCODING_GZIP = 2;
const ENCODING_DEFLATE = 4;
const ENCODING_ANY = ENCODING_BR | ENCODING_GZIP | ENCODING_DEFLATE;

/**
 * The encoding to answer with, read straight off Accept-Encoding rather than through negotiator:
 * the header is a short list of names with an optional q, and building a Negotiator per response
 * to read it costs more than the scan does.
 *
 * The tie-break is negotiator's, for the list the compression module hands it: brotli first, then
 * gzip, then deflate, and identity last.
 *
 * Only the encodings named in `allowed` are on offer, since the caller may not be able to
 * produce all three: express.static offers the two it can have lying on disk. An uncompressed
 * answer is always on offer, and is what an empty header ends up choosing.
 *
 * @param {string} accept the header, or "" when the request carried none
 * @param {number} allowed ENCODING_BR, ENCODING_GZIP and ENCODING_DEFLATE, or'd together
 * @returns {string} "br", "gzip", "deflate", "identity", or "" when nothing is acceptable
 */
function negotiateEncoding(accept, allowed) {
    // -1 while a name has not appeared: q=0 is a refusal and has to be told apart from silence
    let br = -1;
    let gzip = -1;
    let deflate = -1;
    let identity = -1;
    let star = -1;
    // the lowest q anything was named with, which is what an unnamed identity is worth, see below
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
                // a q nobody can read is a refusal, which is how negotiator reads it too
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
    if (gzip < 0) gzip = star;
    if (deflate < 0) deflate = star;
    // An uncompressed answer that the request did not name is worth the lowest q it named
    // anything with, which is negotiator's rule and not the obvious one: "br;q=0.5, gzip;q=0.9"
    // means gzip, because identity comes in at 0.5 rather than at 1 and does not win the list.
    // A "*" names identity as much as it names anything else, so its q is identity's.
    if (identity < 0) identity = star < 0 ? minQuality : star;

    if (!(allowed & ENCODING_BR)) br = -1;
    if (!(allowed & ENCODING_GZIP)) gzip = -1;
    if (!(allowed & ENCODING_DEFLATE)) deflate = -1;

    let best = "";
    let bestQ = 0;
    if (br > bestQ) {
        best = "br";
        bestQ = br;
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
    // off by default, unlike Express, which keeps it for historical reasons. It only tells anyone
    // asking which framework is running, and every hardening guide says to remove it. Set it back
    // to true if something depends on it.
    "x-powered-by": false,
    // fulmine's own: unchanged small files served by sendFile come from a bounded cache
    // validated per request against the file's stat, see Application#readSmallFile
    "file cache": true,
    // "case sensitive routing" is deliberately absent: unset means insensitive, as in Express 5.
    // The native µWS router matches bytes, so the compiler in _compileOptimizedRoutes only hands
    // it routes whose earlier siblings it can prove agree under either case rule.
    "declarative responses": true,
    // on. Off hands every request to the ordinary chain instead of letting µWS match what it can,
    // which is slower and answers the same. Not a tuning knob: it exists so one application can be
    // served both ways and the two sets of answers compared, which tests the optimizer against the
    // rest of the framework without a second framework to compare with. See
    // `npm run fuzz -- --self`. A compiled response needs a native registration to hang on, so this
    // takes "declarative responses" with it.
    "native routes": true,
    // off: with a window set, the size and mtime of a file served by sendFile are remembered for
    // it, which is one syscall less per request and a file that can be served as it was a moment
    // ago. "stat cache ms" is the window in milliseconds, compiled from it by set()
    "stat cache": false,
    "stat cache ms": 0,
    // off, and it is a security setting rather than a compatibility one: with it on, req.ip is the
    // address a PROXY protocol preamble declared. µWS reads that preamble from any client, so this
    // belongs only to a server nothing can reach except the proxy in front of it. See Request#_readRawIp
    "trust proxy protocol": false,
    // on, because Express sends both on every response. Off, nothing is advertised and only a
    // connection that is closing says so, which is fewer bytes and one header write less
    "connection headers": true
};

// Moved by Application#set and by a mount, whichever app they happen on: a router cannot know
// which mounted children resolve a setting through it, so instead of walking them the resolved
// copies everywhere go stale at once and are re-read on their next use, see Router#_hot
const settingsEpoch = { n: 1 };

// What a file's stat was, for as long as "stat cache" says it stays good. Size and mtime only,
// never a body, and only when a window was asked for: nginx's open_file_cache makes the same
// trade, and the worst a stale entry does is answer with the file as it was a moment ago.
const statCache = new Map();
const STAT_CACHE_LIMIT = 4096;

/**
 * The stat of a path, from the cache when a window was asked for and it is still good.
 *
 * A failure is never remembered: a file that is not there is not the hot path, and a file that
 * appears has to be seen at once.
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
    // cleared rather than evicted one by one, as twinsOf does: a directory big enough to reach
    // the limit is being served by something other than an application server anyway
    if (statCache.size >= STAT_CACHE_LIMIT) {
        statCache.clear();
    }
    statCache.set(file, { stat, until: now + ttl });
    return stat;
}

/**
 * A duration setting as milliseconds: false is off, a string is read by ms, a number is itself.
 *
 * @param {any} value
 * @param {string} name for the error, which names the setting the application wrote
 * @returns {number}
 */
function durationSetting(value, name) {
    const parsed =
        value === false || value === undefined ? 0 : typeof value === "string" ? ms(/** @type {any} */ (value)) : value;
    if (typeof parsed !== "number" || !(parsed >= 0)) {
        throw new TypeError(`${name} must be a duration`);
    }
    return parsed;
}

/**
 * Turns whatever "trust proxy" was set to into the function proxy-addr wants: a predicate saying
 * whether the address at hop i is trusted. true trusts everything, a number trusts that many hops,
 * and a string or a list is read as addresses and subnet names.
 *
 * @param {boolean|number|string|string[]|Function} val
 * @returns {Function}
 */
function compileTrust(val) {
    if (typeof val === "function") return val;

    if (val === true) {
        // Support plain true/false
        return function () {
            return true;
        };
    }

    if (typeof val === "number") {
        // Support trusting hop count
        return function (a, i) {
            return i < val;
        };
    }

    if (typeof val === "string") {
        // Support comma-separated values
        val = val.split(",").map(function (v) {
            return v.trim();
        });
    }

    return proxyaddr.compile(val || []);
}

const shownWarnings = new Set();
/**
 * Warns once per call site that a method has a newer name, in the format the deprecate package
 * uses, so the output sits alongside the warnings Express's own dependencies produce. Once per
 * site rather than once per call: the same line warning on every request would be a flood.
 *
 * @param {string} oldMethod
 * @param {string} newMethod
 * @param {boolean} [full] print the whole stack rather than the one frame that called it
 */
function deprecated(oldMethod, newMethod, full = false) {
    const err = new Error();
    // V8 always fills this in for an Error made right here
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
 * findIndex, but resuming from a position. The router walks the same route list many times per
 * request, each time picking up after the route it just ran, and Array.findIndex has no way to
 * start anywhere but the beginning.
 *
 * @param {any[]} arr
 * @param {(item: any, index: number, arr: any[]) => boolean} fn
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
 * decodeURIComponent that answers rather than throwing. A malformed escape in a URL is a bad
 * request and not an exception, so callers check for the sentinel and answer 400.
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
 * A route parameter as the application should see it, which means decoded: `/users/caff%C3%A8`
 * arrives as "caffè". A percent sequence that will not decode is the client's mistake and becomes a
 * 400, with the message Express uses.
 *
 * @param {string} value
 * @returns {string}
 * @throws {any} carrying status 400 when the value cannot be decoded
 */
function decodeParam(value) {
    // the common case, and worth the check: a parameter is usually a number or a word, and
    // decodeURIComponent is not free
    if (value.indexOf("%") === -1) {
        return value;
    }
    try {
        return decodeURIComponent(value);
    } catch {
        // a URIError, not an Error: express throws what decodeURIComponent threw, so an error
        // handler written as `err instanceof URIError` has to keep working here
        const err = /** @type {any} */ (new URIError(`Failed to decode param '${value}'`));
        err.status = 400;
        err.statusCode = 400;
        err.expose = true;
        throw err;
    }
}

const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * Whether any segment is a dotfile. A single "." is not one, being the current directory, which is
 * why the length is checked before the first character.
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
 * Splits a comma-separated header value into its tokens, trimming the spaces around each. Written
 * out by hand rather than with split and trim because it runs for every conditional request.
 *
 * @param {string} str
 * @returns {string[]}
 */
function parseTokenList(str) {
    let end = 0;
    const list = [];
    let start = 0;

    // gather tokens
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

    // final token
    if (start !== end) {
        list.push(str.substring(start, end));
    }

    return list;
}

/**
 * An HTTP date as a timestamp, or NaN when it is missing or unreadable. NaN rather than a throw
 * because every comparison against it is false, which is the answer a bad date should give.
 *
 * @param {string|undefined} date
 * @returns {number}
 */
function parseHttpDate(date) {
    const timestamp = date && Date.parse(date);
    return typeof timestamp === "number" ? timestamp : NaN;
}

/**
 * Whether the request's If-Match or If-Unmodified-Since says the copy the client is acting on is
 * no longer the current one, which is a 412 rather than a 304: the client asked to be stopped if
 * anything had changed.
 *
 * @param {any} req
 * @param {any} res
 * @returns {boolean}
 */
function isPreconditionFailure(req, res) {
    const match = req.headers["if-match"];

    // if-match
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

    // if-unmodified-since
    const unmodifiedSince = parseHttpDate(req.headers["if-unmodified-since"]);
    if (!isNaN(unmodifiedSince)) {
        const lastModified = parseHttpDate(res.get("Last-Modified"));
        return isNaN(lastModified) || lastModified > unmodifiedSince;
    }

    return false;
}

// the sha1 of nothing, which the etag package answers with without hashing
const EMPTY_ENTITY_TAG = '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';

/**
 * The ETag of a body: its length in hex, a dash, and the first 27 characters of the base64 sha1.
 * The same string the etag package produces, and tests/unit/utils.test.js holds it to that.
 *
 * crypto.hash and not crypto.createHash: the one-shot form allocates no hash object, and on a 500
 * byte body it is twice as fast for the same answer, 924ns against 1963.
 *
 * @param {Buffer|string} entity
 * @param {boolean} weak
 * @returns {string}
 */
function entityTag(entity, weak) {
    if (entity.length === 0) {
        return weak ? "W/" + EMPTY_ENTITY_TAG : EMPTY_ENTITY_TAG;
    }
    // the byte length, which for a string is not its character count
    const len = typeof entity === "string" ? Buffer.byteLength(entity, "utf8") : entity.length;
    const tag = `"${len.toString(16)}-${crypto.hash("sha1", entity, "base64").substring(0, 27)}"`;
    return weak ? "W/" + tag : tag;
}

/**
 * The ETag of a file, which is its size and mtime rather than its contents: send computes it this
 * way so that serving a large file does not mean reading it twice.
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
 * The function the "etag" setting installs. It takes either a body or an fs.Stats, since a file's
 * ETag comes from its size and mtime while a body's comes from its contents.
 *
 * @param {{weak: boolean}} options
 * @returns {(body: any, encoding?: BufferEncoding) => string}
 */
function createETagGenerator(options) {
    return function generateETag(body, encoding) {
        if (body instanceof Stats) {
            return statTag(body, options.weak);
        }
        // crypto.hash reads a string as the utf8 bytes Buffer.from would have produced, so the tag
        // is the same one without copying the whole body first
        if (typeof body === "string" && (encoding === undefined || encoding === "utf8" || encoding === "utf-8")) {
            return entityTag(body, options.weak);
        }
        const buf = !Buffer.isBuffer(body) ? Buffer.from(body, encoding) : body;
        return entityTag(buf, options.weak);
    };
}

/**
 * Whether an If-Range still holds, which decides between answering the range that was asked for
 * and sending the whole file. It may carry either an ETag or a date, and a date only counts when
 * it matches Last-Modified exactly.
 *
 * @param {any} req
 * @param {any} res
 * @returns {boolean}
 */
function isRangeFresh(req, res) {
    const ifRange = req.headers["if-range"];
    if (!ifRange) {
        return true;
    }

    // if-range as etag
    if (ifRange.indexOf('"') !== -1) {
        const etag = res.get("etag");
        return Boolean(etag && ifRange.indexOf(etag) !== -1);
    }

    // if-range as modified date
    const lastModified = res.get("Last-Modified");
    return parseHttpDate(lastModified) <= parseHttpDate(ifRange);
}

/**
 * Escapes the five characters that would otherwise be markup. Written as a scan rather than a
 * chain of replaces because it runs on every error page and every redirect body.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    const s = String(str);
    const len = s.length;
    let i = 0;

    // Fast scan: find first char that needs escaping
    for (; i < len; i++) {
        const ch = s.charCodeAt(i);
        if (ch === 0x26 || ch === 0x3c || ch === 0x3e || ch === 0x22 || ch === 0x27) {
            break;
        }
    }

    // No escaping needed
    if (i === len) return s;

    // Build escaped string from the first match onward
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

// a charset parameter that is already there, and the whole parameter so it can be replaced
const CHARSET_PRESENT = /;\s*charset\s*=/i;
const CHARSET_PARAM = /;\s*charset\s*=\s*[^;]*/i;
const UTF8_CHARSET = "; charset=utf-8";

/**
 * The value plus the charset its media type implies: text/* gets one, and so does any type whose
 * mime database entry names one. Memoized, since an application sends two or three content-types
 * and working it out again costs 159ns against 7.
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
 * The same content-type, saying utf-8. A string body is written as utf-8 whatever the header
 * claimed, so a header claiming otherwise is wrong on the wire, and Express replaces it too.
 *
 * @param {string} value
 * @returns {string}
 */
function withUtf8Charset(value) {
    // almost every string body already carries the header in this exact form, and the pair of
    // regular expressions below was 2% of the time spent serving a request
    if (value.endsWith(UTF8_CHARSET)) {
        return value;
    }
    return CHARSET_PARAM.test(value) ? value.replace(CHARSET_PARAM, UTF8_CHARSET) : `${value}${UTF8_CHARSET}`;
}

// What node lets a header name and a header value hold. Express gets these checks from node's own
// setHeader, and uWS makes them load bearing rather than cosmetic: it writes `key: value\r\n` with
// no validation of its own, so a CR or an LF that reaches it ends the header early and everything
// after it is read by the client as a header of its own, or as a whole second response.
const HEADER_TOKEN = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
const HEADER_VALUE = /[^\t\x20-\x7e\x80-\xff]/;

/**
 * One of node's header errors, built the way node builds it.
 *
 * Assigning the code is not the whole of it. Node also puts the code in the first line of the
 * stack, by naming the error "TypeError [THE_CODE]" while V8 formats that line and then taking
 * the name back off. Whatever prints a stack therefore says which code it was, and the default
 * error page prints exactly that: without this, the same refusal reads "TypeError:" here and
 * "TypeError [ERR_INVALID_CHAR]:" behind Express. Found by fuzzing against express.
 *
 * @param {string} message
 * @param {string} code
 * @returns {NodeJS.ErrnoException}
 */
function headerError(message, code) {
    /** @type {NodeJS.ErrnoException} */
    const err = new TypeError(message);
    err.name = `TypeError [${code}]`;
    // reading it is what makes V8 format the line, and it formats it from the name above
    void err.stack;
    // back to the prototype's "TypeError", which is what node leaves behind. Cast because Error
    // declares name as always present, and this deletes the own property to uncover it again
    delete (/** @type {any} */ (err).name);
    err.code = code;
    return err;
}

/**
 * Refuses a header name that is not an HTTP token, the way node's setHeader does and with its
 * error, so an application catching ERR_INVALID_HTTP_TOKEN behind Express catches it here.
 *
 * @param {any} name
 * @returns {void}
 * @throws {TypeError} if the name is not a token, which includes not being a string
 */
function validateHeaderName(name) {
    if (typeof name !== "string" || !HEADER_TOKEN.test(name)) {
        throw headerError(`Header name must be a valid HTTP token ["${name}"]`, "ERR_INVALID_HTTP_TOKEN");
    }
}

// values already accepted, so the constant strings middleware writes per request, helmet's CSP
// among them, skip the scan. Insert-only after the regex accepts, so a hit cannot change a
// verdict; bounded, and set-cookie values are per-user so they stay out
const KNOWN_HEADER_VALUES = new Set();

/**
 * Refuses a header value holding a character that cannot go on the wire, with node's error. An
 * array is sent as one header per entry, so each entry is checked on its own rather than as the
 * comma joined string node happens to test.
 *
 * @param {string} name the header being set, which is what node names in the message
 * @param {string|string[]} value already coerced to text
 * @returns {void}
 * @throws {TypeError} if a character is not allowed in a header value
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
 * Whether this pair could be written to the wire at all. Used on the error path, where throwing
 * again is what turns one bad header into a dead process.
 *
 * @param {string} name
 * @param {any} value
 * @returns {boolean}
 */
function headerIsWritable(name, value) {
    if (!HEADER_TOKEN.test(name)) {
        return false;
    }
    return Array.isArray(value) ? value.every((one) => !HEADER_VALUE.test(one)) : !HEADER_VALUE.test(value);
}

// The status send picks for a failed stat. Anything else is the file being there but unreadable,
// which is the server's problem and not the request's.
const STAT_ERROR_STATUS = { ENAMETOOLONG: 404, ENOTDIR: 404, ENOENT: 404 };

/**
 * The error send and serve-static refuse with, so that the file serving here refuses the same way.
 *
 * They build these with http-errors, so they carry `status`, `statusCode` and `expose`, which is
 * what `res.status(err.status || 500)` reads. Without a status a 403, a 404 and a 416 all came out
 * of that handler as 500. The message is the status's own name, as http-errors writes it.
 *
 * @param {number} status
 * @returns {any}
 */
function httpError(status) {
    const message = statuses.message[status] ?? "Error";
    const err = /** @type {any} */ (new Error(message));
    // http-errors names these BadRequestError, ForbiddenError and so on, and the name is what the
    // error page shows: an application looking at a 400 sees the same word Express shows it. Set
    // before anything reads the stack, which V8 formats on first read
    err.name = `${message.replace(/\W/g, "")}Error`;
    err.expose = status < 500;
    err.statusCode = status;
    err.status = status;
    return err;
}

/**
 * Marks an fs error the way send does before it is handed on, so an error handler reading
 * err.status or err.statusCode finds what it would find behind Express. The three properties are
 * assigned in this order because they are serialised in insertion order, and an error handler that
 * answers with res.send(err) sends them.
 *
 * The error itself is returned rather than a new one, so its errno, code, syscall and path survive.
 *
 * @param {any} err
 * @returns {any} the same error
 */
function asStatError(err) {
    err.expose = false;
    err.statusCode = STAT_ERROR_STATUS[err.code] ?? 500;
    err.status = err.statusCode;
    return err;
}

// fast null object
// A constructor whose instances have no prototype, so a key from a request body or a query string
// cannot reach Object.prototype. Typed as returning a plain record: without that, assigning one
// reads as assigning `any`, which resets narrowing instead of removing undefined from it.
/** @type {new () => Record<string, any>} */
const NullObject = /** @type {any} */ (function () {});
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
    negotiateEncoding,
    ENCODING_BR,
    ENCODING_GZIP,
    ENCODING_DEFLATE,
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
    EMPTY_REGEX,
    settingsEpoch
};
