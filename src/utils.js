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

const mime = require("mime-types");
const path = require("path");
const proxyaddr = require("proxy-addr");
const qs = require("qs");
const querystring = require("fast-querystring");
const etag = require("etag");
const { Stats } = require("fs");

const EMPTY_REGEX = new RegExp(``);

function fastQueryParse(query, options) {
    // Express 5 hands back a null-prototype object here, which is why req.query prints as
    // "[Object: null prototype] {}". Express 4 spread it into a plain object; keeping that would
    // put Object.prototype keys back within reach of a query string.
    const len = query.length;
    if (len === 0) {
        return new NullObject();
    }
    if (len <= 128) {
        if (!query.includes("[") && !query.includes("%5B") && !query.includes(".") && !query.includes("%2E")) {
            return Object.assign(new NullObject(), querystring.parse(query));
        }
    }
    return Object.assign(new NullObject(), qs.parse(query, options));
}

function removeDuplicateSlashes(path) {
    return path.replace(/\/{2,}/g, "/");
}

/**
 * Compiles an Express 5 path into a regex.
 *
 * Express 5 moved to path-to-regexp v8, which is a much smaller language than v4's:
 *   - :param          a named parameter, one segment
 *   - /*splat         a named wildcard, one or more segments, captured as an array
 *   - {...}           an optional group, which is how v5 spells v4's trailing `?`
 *   - \x              an escaped literal
 *
 * What v4 allowed and v5 does not: bare `*` with no name, unnamed parameters, inline
 * regex like :id(\\d+), and the `+`, `?`, `()` operators. Those throw rather than
 * silently matching something else, because a route that quietly stops matching is
 * worse than one that fails at startup.
 *
 * Wildcard names are recorded on the returned regex so the router can split their
 * value into the array v5 hands to req.params.
 */
function patternToRegex(pattern, isPrefix = false) {
    if (pattern instanceof RegExp) {
        return pattern;
    }
    if (isPrefix && pattern === "") {
        return EMPTY_REGEX;
    }

    let regexPattern = "";
    let i = 0;
    const len = pattern.length;
    const wildcardNames = [];
    // whether the token just emitted was a :parameter, which decides how greedy the next
    // optional group is allowed to be. see the comment where it is read
    let lastTokenWasParam = false;

    while (i < len) {
        const ch = pattern[i];

        if (ch === "\\" && i + 1 < len) {
            regexPattern += "\\" + pattern[i + 1];
            i += 2;
            continue;
        }

        // *splat: one or more characters, slashes included. It is not anchored to a segment
        // boundary, so /te*st is literal "/te" followed by a wildcard named "st"
        if (ch === "*") {
            const at = i;
            i++;
            let name = "";
            while (i < len && /\w/.test(pattern[i])) {
                name += pattern[i++];
            }
            if (!name) {
                throw new Error(`Missing parameter name at index ${at}: ${pattern}`);
            }
            wildcardNames.push(name);
            regexPattern += `(?<${name}>[^]+)`;
            lastTokenWasParam = false;
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
                wildcardNames.push(name);
                if (regexPattern.endsWith("/") || regexPattern.endsWith("\\/")) {
                    // the slash belongs to the optional part, otherwise /{*splat} would not match /
                    regexPattern = regexPattern.slice(0, regexPattern.endsWith("\\/") ? -2 : -1);
                    regexPattern += `(?:/(?<${name}>.+))?/?`;
                } else {
                    regexPattern += `(?<${name}>.*)`;
                }
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
            const separator = lastTokenWasParam && groupContent[0] && groupContent[0] !== ":" ? groupContent[0] : "";
            const groupParamClass = `[^/${separator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]+`;

            let groupRegex = "";
            let gi = 0;
            while (gi < groupContent.length) {
                if (groupContent[gi] === ":") {
                    gi++;
                    let paramName = "";
                    while (gi < groupContent.length && /\w/.test(groupContent[gi])) {
                        paramName += groupContent[gi++];
                    }
                    groupRegex += `(?<${paramName}>${groupParamClass})`;
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
            regexPattern += `(?:${groupRegex})?`;
            lastTokenWasParam = false;
            continue;
        }

        if (ch === ":") {
            i++;
            let name = "";
            while (i < len && /\w/.test(pattern[i])) {
                name += pattern[i++];
            }
            if (!name) {
                throw new Error(`Missing parameter name at index ${i - 1}: ${pattern}`);
            }
            // a following optional group needs room to match, so the parameter gives ground
            regexPattern += i < len && pattern[i] === "{" ? `(?<${name}>[^/]+?)` : `(?<${name}>[^/]+)`;
            lastTokenWasParam = true;
            continue;
        }

        // These are the Express 4 operators. Express 5 has no meaning for them and refuses the
        // route rather than matching them literally, which is what makes a v4 path fail loudly
        // at startup instead of quietly never matching. Escape them to use them as literals.
        if ("?+()[]!".includes(ch)) {
            throw new Error(`Unexpected ${ch} at index ${i}: ${pattern}`);
        }

        if (".^$|}".includes(ch)) {
            regexPattern += "\\" + ch;
        } else {
            regexPattern += ch;
        }
        lastTokenWasParam = false;
        i++;
    }

    const regex = new RegExp(`^${regexPattern}${isPrefix ? "(?=$|/)" : "$"}`);
    regex._wildcardNames = wildcardNames;
    return regex;
}

function needsConversionToRegex(pattern) {
    if (pattern instanceof RegExp) {
        return false;
    }

    return pattern.includes("*") || pattern.includes(":") || pattern.includes("{");
}

function canBeOptimized(pattern) {
    if (pattern instanceof RegExp) {
        return false;
    }
    return !pattern.includes("*") && !pattern.includes("{") && !pattern.includes(":");
}

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

function normalizeType(type) {
    return ~type.indexOf("/")
        ? acceptParams(type)
        : { value: mime.lookup(type) || "application/octet-stream", params: {} };
}

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

const defaultSettings = {
    "jsonp callback name": "callback",
    env: () => process.env.NODE_ENV ?? "development",
    etag: "weak",
    "etag fn": () => createETagGenerator({ weak: true }),
    "query parser": "extended",
    "query parser fn": () => fastQueryParse,
    "subdomain offset": 2,
    "trust proxy": false,
    views: () => path.join(process.cwd(), "views"),
    "view cache": () => process.env.NODE_ENV === "production",
    "x-powered-by": true,
    "case sensitive routing": true,
    "declarative responses": true
};

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
function deprecated(oldMethod, newMethod, full = false) {
    const err = new Error();
    const pos = full
        ? err.stack.split("\n").slice(1).join("\n")
        : err.stack.split("\n")[3].trim().split("(").slice(1).join("(").split(")").slice(0, -1).join(")");
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
        })} u-express deprecated ${oldMethod}: Use ${newMethod} instead at ${pos}`
    );
}

function findIndexStartingFrom(arr, fn, index = 0) {
    for (let i = index, end = arr.length; i < end; i++) {
        if (fn(arr[i], i, arr)) {
            return i;
        }
    }
    return -1;
}

function decode(path) {
    try {
        return decodeURIComponent(path);
    } catch (err) {
        return -1;
    }
}

const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

function containsDotFile(parts) {
    for (let i = 0, len = parts.length; i < len; i++) {
        const part = parts[i];
        if (part.length > 1 && part[0] === ".") {
            return true;
        }
    }

    return false;
}

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

function parseHttpDate(date) {
    const timestamp = date && Date.parse(date);
    return typeof timestamp === "number" ? timestamp : NaN;
}

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

function createETagGenerator(options) {
    return function generateETag(body, encoding) {
        if (body instanceof Stats) {
            return etag(body, options);
        }
        const buf = !Buffer.isBuffer(body) ? Buffer.from(body, encoding) : body;
        return etag(buf, options);
    };
}

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

// fast null object
const NullObject = function () {};
NullObject.prototype = Object.create(null);

module.exports = {
    removeDuplicateSlashes,
    patternToRegex,
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
    containsDotFile,
    parseTokenList,
    parseHttpDate,
    isPreconditionFailure,
    createETagGenerator,
    isRangeFresh,
    findIndexStartingFrom,
    fastQueryParse,
    canBeOptimized,
    escapeHtml,
    EMPTY_REGEX
};
