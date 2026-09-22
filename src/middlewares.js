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

const fs = require("fs");
const path = require("path");
const bytes = require("bytes");
const zlib = require("fast-zlib");
const typeis = require("type-is");
const mime = require("mime-types");
const compressible = require("compressible");
const ms = require("ms");
const qs = require("qs");
const statuses = require("statuses");
const parseQuery = require("./parse-query.js");
const { kGetSafe } = require("./usage.js");
const { AsyncResource } = require("async_hooks");

/**
 * AsyncResource.bind without node's generic wrapper: ~1.9us per call there, ~0.08 here.
 *
 * @param {(...args: any[]) => any} fn called with at most one argument by every caller here
 * @returns {(err?: any) => any}
 */
function bindContext(fn) {
    const resource = new AsyncResource(fn.name || "bound-anonymous-fn");
    return (err) => resource.runInAsyncScope(fn, undefined, err);
}
const {
    fastQueryParse,
    NullObject,
    asStatError,
    httpError,
    httpErrorName,
    memoizeByString,
    containsDotFile,
    negotiateEncoding,
    cachedStat,
    ENCODING_BR,
    ENCODING_GZIP
} = require("./utils.js");

// the largest content-length a body buffer is allocated for up front, so a declared and never
// sent body cannot pin more memory than a real one
const MAX_PREALLOCATED_BODY = 1024 * 1024;

// what the finish pass feeds zlib: no bytes, only the flush flag
const EMPTY_BUFFER = Buffer.alloc(0);

// the twins express.static serves with preCompressed on, the suffixes nginx and every build
// tool agree on, ordered by what is worth having
const PRECOMPRESSED = [
    { encoding: "br", suffix: ".br", flag: ENCODING_BR },
    { encoding: "gzip", suffix: ".gz", flag: ENCODING_GZIP }
];

/** @typedef {import("./request.js")} Request */
/** @typedef {import("./response.js")} Response */
/** @typedef {import("./utils.js").HttpError} HttpError */
/** @typedef {import("./options").BodyParserOptions} BodyParserOptions */
/**
 * A decompressor from fast-zlib, carrying the flag its final flush passes, see createInflate.
 * @typedef {(import("fast-zlib").Inflate|import("fast-zlib").Gunzip|import("fast-zlib").BrotliDecompress)
 *   & {_finishFlag?: number}} Inflater
 */
/**
 * What a parser does with the collected bytes. `body` is not a field of Request, see there, so it
 * is added here; the charset is undefined only for raw.
 * @typedef {(
 *   req: Request & {body?: unknown},
 *   res: Response,
 *   next: (err?: unknown) => void,
 *   options: BodyParserOptions,
 *   buf: Buffer,
 *   encoding: string|undefined
 * ) => void} BodyHandler
 */

// The failures express.static passes to the next handler when fallthrough is on: all of them mean
// the request is not a file here. A 412 and a 416 are about a file that exists, so they are
// answered: falling through turned a Range Not Satisfiable into a 404.
const FALLTHROUGH_STATUSES = new Set([400, 403, 404]);

/**
 * A run of leading slashes reduced to one, as serve-static does: a Location of "//assets/" is
 * protocol-relative and sends the browser to a host called "assets".
 *
 * @param {string} path
 * @returns {string}
 */
function collapseLeadingSlashes(path) {
    let i = 0;
    while (i < path.length && path.charCodeAt(i) === 0x2f) {
        i++;
    }
    return i > 1 ? "/" + path.slice(i) : path;
}

/**
 * The text without a leading byte order mark, as iconv hands it to body-parser.
 *
 * @param {string} text
 * @returns {string}
 */
function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** @type {typeof import("iconv-lite")|undefined} */
let iconv;

/**
 * iconv-lite, loaded only for a charset the Buffer cannot decode.
 *
 * @returns {typeof import("iconv-lite")}
 */
function loadIconv() {
    if (!iconv) iconv = require("iconv-lite");
    return iconv;
}

// charsets decoded straight through the Buffer, without iconv
const BUFFER_CHARSETS = new Set(["utf-8", "utf-16le", "latin1", "iso-8859-1"]);

/**
 * The charset parameter of a content-type, lowercased and unquoted, or undefined.
 *
 * @param {string|undefined} contentType
 * @returns {string|undefined}
 */
function charsetOf(contentType) {
    if (!contentType) {
        return undefined;
    }
    let index = contentType.indexOf("charset=");
    if (index === -1) {
        // the lowercase spelling is the fast path, other casings only when there are parameters
        if (contentType.indexOf(";") === -1) {
            return undefined;
        }
        const match = /charset=/i.exec(contentType);
        if (match === null) {
            return undefined;
        }
        index = match.index;
    }
    let value = contentType.substring(index + 8);
    const semicolonIndex = value.indexOf(";");
    if (semicolonIndex !== -1) {
        value = value.substring(0, semicolonIndex);
    }
    value = value.trim();
    if (value.charCodeAt(0) === 0x22 && value.charCodeAt(value.length - 1) === 0x22) {
        value = value.slice(1, -1);
    }
    return value ? value.toLowerCase() : undefined;
}

/**
 * The 415 a charset nobody can decode gets, worded as body-parser words it.
 *
 * @param {string} charset already lowercased
 * @returns {Error}
 */
function charsetError(charset) {
    return bodyError('unsupported charset "' + charset.toUpperCase() + '"', 415, "charset.unsupported", {
        charset
    });
}

/**
 * The body decoded under a charset, through the Buffer where node knows the name, iconv-lite
 * otherwise. The Buffer keeps a byte order mark, so the json parser strips it itself.
 *
 * @param {Buffer} buf
 * @param {string} encoding already lowercased, and already known to be decodable
 * @returns {string}
 */
function decodeBody(buf, encoding) {
    switch (encoding) {
        case "utf-8":
            return buf.toString();
        case "utf-16le":
            return buf.toString("utf-16le");
        case "latin1":
        case "iso-8859-1":
            return buf.toString("latin1");
        default:
            return loadIconv().decode(buf, /** @type {import("iconv-lite").Encoding} */ (encoding));
    }
}

/**
 * Runs the verify hook as body-parser does, an empty body included; a throw is the 403
 * entity.verify.failed. Answers whether parsing may continue.
 *
 * @param {Request} req
 * @param {Response} res
 * @param {(err?: unknown) => void} next
 * @param {BodyParserOptions} options the parser options, settled by createBodyParser
 * @param {Buffer} buf
 * @param {string|undefined} encoding the charset the body is about to be decoded with, undefined
 *   for raw, which never decodes
 * @returns {boolean}
 */
function runVerify(req, res, next, options, buf, encoding) {
    if (!options.verify) {
        return true;
    }
    try {
        // the charset too, as body-parser hands it; raw gets null
        options.verify(req, res, buf, encoding ?? null);
        return true;
    } catch (e) {
        next(verifyError(e, buf));
        return false;
    }
}

/**
 * A verify hook's throw as body-parser shapes it: an Error kept with its own status, a string a
 * 403 with that message, anything else a plain 403.
 *
 * @param {unknown} thrown
 * @param {Buffer} buf the body, which rides on the error as body-parser puts it there
 * @returns {HttpError}
 */
function verifyError(thrown, buf) {
    const own = thrown instanceof Error ? /** @type {HttpError} */ (thrown) : undefined;
    let status = own ? own.status || own.statusCode || 403 : 403;
    // http-errors answers 500 for a status it cannot answer with
    if (typeof status !== "number" || (!statuses.message[status] && (status < 400 || status >= 600))) {
        status = 500;
    }
    const err = own ?? httpError(status, typeof thrown === "string" ? thrown : undefined);
    const type = /** @type {{type?: string}|null|undefined} */ (thrown)?.type || "entity.verify.failed";
    return asBodyError(err, status, type, { body: buf });
}

/**
 * The message a strict violation gets, V8's own as body-parser gets it: the body up to the
 * offending character then placeholders, JSON.parse made to fail on it, the real characters put back.
 *
 * @param {string} text the body as sent
 * @param {string|undefined} char the first character that is neither whitespace nor { nor [
 * @returns {string}
 */
function strictSyntaxMessage(text, char) {
    const index = char === undefined ? -1 : text.indexOf(char);
    if (index === -1) {
        return "Unexpected end of JSON input";
    }
    const partial = text.substring(0, index) + "#".repeat(text.length - index);
    try {
        JSON.parse(partial);
    } catch (e) {
        return /** @type {SyntaxError} */ (e).message.replace(/#+/g, (/** @type {string} */ placeholder) =>
            text.substring(index, index + placeholder.length)
        );
    }
    return "strict violation";
}

/**
 * The error a body parser hands to next(), as body-parser shapes it: a status and a `type`.
 *
 * @param {string} message
 * @param {number} status
 * @param {string} type body-parser's own name for the kind of failure
 * @param {object} [extra] anything else body-parser puts on that particular error
 * @returns {Error}
 */
function bodyError(message, status, type, extra) {
    /** @type {HttpError} */
    const err = new Error(message);
    // http-errors' name, "PayloadTooLargeError"
    err.name = httpErrorName(status);
    return asBodyError(err, status, type, extra);
}

/**
 * The same on an error somebody else made, JSON.parse's SyntaxError or a verify hook's, decorated
 * rather than replaced as http-errors does.
 *
 * @param {HttpError} err
 * @param {number} status
 * @param {string} type body-parser's own name for the kind of failure
 * @param {object} [extra] anything else body-parser puts on that particular error
 * @returns {Error}
 */
function asBodyError(err, status, type, extra) {
    err.expose = status < 500;
    err.statusCode = status;
    err.status = status;
    err.type = type;
    return Object.assign(err, extra);
}

/**
 * Whether a file of this extension may have a `.br` or `.gz` twin: a webp or a woff2 never does,
 * and looking cost two stats. An unknown extension is looked up, it might be text.
 *
 * @param {string} extension including the dot, or "" for a name without one
 * @returns {boolean}
 */
const hasTwins = memoizeByString((extension) => {
    const type = mime.lookup(extension);
    return type ? compressible(type) === true : true;
});

// which twins a path has, remembered for a moment: only their presence, never size or mtime, so a
// changed file is never described by a stale number. The trade nginx's open_file_cache makes
const twinCache = new Map();
const TWIN_CACHE_LIMIT = 4096;

/**
 * What is known about a path's twins, a record to fill in.
 *
 * @param {string} filePath
 * @param {number} ttl how long an answer stays good, in milliseconds
 * @returns {{br: boolean|undefined, gz: boolean|undefined, until: number}}
 */
function twinsOf(filePath, ttl) {
    const now = Date.now();
    const known = twinCache.get(filePath);
    if (known !== undefined && known.until > now) {
        return known;
    }
    const entry = { br: undefined, gz: undefined, until: now + ttl };
    if (twinCache.size >= TWIN_CACHE_LIMIT) {
        twinCache.clear();
    }
    twinCache.set(filePath, entry);
    return entry;
}

/**
 * The compressed twin to serve in place of a file, or undefined when the client does not take one
 * or it is not there. Its own stat comes back with it, so the ETag and Last-Modified are the
 * variant's: two bodies under one ETag makes a shared cache hand brotli to a client that cannot
 * read it. One stat for a twin, none once twinCache remembers there is no twin.
 *
 * @param {string} filePath absolute path of the file that was asked for
 * @param {string|undefined} accept the request's Accept-Encoding
 * @param {number} ttl how long the twin cache holds an answer, 0 to ask the disk every time
 * @param {number} statTtl how long the twin's own stat stays good, from the "stat cache" setting
 * @returns {{suffix: string, encoding: string, stat: import("fs").Stats}|undefined}
 */
function pickPrecompressed(filePath, accept, ttl, statTtl) {
    if (!accept || !hasTwins(filePath.slice(filePath.lastIndexOf(".")))) {
        return undefined;
    }
    const known = ttl > 0 ? twinsOf(filePath, ttl) : undefined;
    let allowed = ENCODING_BR | ENCODING_GZIP;
    // twice at most: brotli won and there is no .br on disk
    for (let attempt = 0; attempt < 2; attempt++) {
        const chosen = negotiateEncoding(accept, allowed);
        const variant = PRECOMPRESSED.find((candidate) => candidate.encoding === chosen);
        if (!variant) {
            return undefined;
        }
        if (known === undefined || known[variant.encoding === "br" ? "br" : "gz"] !== false) {
            try {
                const stat = cachedStat(filePath + variant.suffix, statTtl);
                if (!stat.isDirectory()) {
                    if (known !== undefined) known[variant.encoding === "br" ? "br" : "gz"] = true;
                    return { suffix: variant.suffix, encoding: variant.encoding, stat };
                }
            } catch {
                // not on disk
            }
            if (known !== undefined) known[variant.encoding === "br" ? "br" : "gz"] = false;
        }
        allowed &= ~variant.flag;
    }
    return undefined;
}

/**
 * send's sendIndex: the index names tried in order, the last failure thrown when every name
 * failed, null when the list ran out without one.
 *
 * @param {string} dir the directory to look in
 * @param {string[]} indexList the index names, in order
 * @returns {{stat: import("fs").Stats, name: string, candidate: string}|null} the file to serve, or null
 */
function findIndexFile(dir, indexList) {
    let lastError;
    for (const name of indexList) {
        const candidate = path.join(dir, name);
        let stat;
        try {
            stat = fs.statSync(candidate);
        } catch (err) {
            lastError = err;
            continue;
        }
        // a directory by that name is neither an index nor an error, as send's loop has it
        if (stat.isDirectory()) {
            lastError = undefined;
            continue;
        }
        return { stat, name, candidate };
    }
    if (lastError) {
        throw lastError;
    }
    return null;
}

/**
 * express.static, a front for res.sendFile: the path, the root, the dotfiles and index rules.
 *
 * @param {string} root directory to serve from
 * @param {import("./options").StaticOptions} [options]
 * @returns {(req: Request, res: Response, next: (err?: unknown) => void) => void}
 */
function serveStatic(root, options) {
    // serve-static's messages
    if (!root) {
        throw new TypeError("root path required");
    }
    if (typeof root !== "string") {
        throw new TypeError("root path must be a string");
    }
    // a copy, as serve-static's Object.create(options): two mounts must not share one root
    options = Object.assign(new NullObject(), options);
    if (typeof options.index === "undefined") options.index = "index.html";
    // a list as send takes it, `false` an empty one
    const indexList = options.index === false || options.index === "" ? [] : [options.index].flat();
    if (typeof options.redirect === "undefined") options.redirect = true;
    if (typeof options.fallthrough === "undefined") options.fallthrough = true;
    if (typeof options.dotfiles === "undefined") options.dotfiles = "ignore";
    if (options.extensions) {
        if (typeof options.extensions !== "string" && !Array.isArray(options.extensions)) {
            throw new Error("extensions must be a string or an array");
        }
        if (!Array.isArray(options.extensions)) {
            options.extensions = [options.extensions];
        }
        options.extensions = options.extensions.map((ext) => (ext.startsWith(".") ? ext.slice(1) : ext));
    }
    if (options.setHeaders !== undefined && typeof options.setHeaders !== "function") {
        throw new TypeError("option setHeaders must be function");
    }
    // serve-static's option, under a name only this middleware writes, see sendFile
    options._setHeaders = options.setHeaders;
    // how long which twins a path has is remembered: a second picks up a deploy while it goes
    // out and costs nothing under any traffic; { cache: false } asks the disk every time
    let twinTtl = 0;
    if (options.preCompressed) {
        const cache = typeof options.preCompressed === "object" ? options.preCompressed.cache : undefined;
        twinTtl =
            cache === undefined
                ? 1000
                : cache === false
                  ? 0
                  : typeof cache === "string"
                    ? ms(/** @type {import("ms").StringValue} */ (cache))
                    : cache;
        if (typeof twinTtl !== "number" || !(twinTtl >= 0)) {
            throw new TypeError("option preCompressed.cache must be a duration");
        }
    }
    options.root = root;
    const resolvedRoot = path.resolve(root);
    // serve-static never asks the app: a static file keeps its ETag under app.set("etag", false)
    options.etag = options.etag !== false;
    options._ownEtag = true;

    return (req, res, next) => {
        // everything down to sendFile is synchronous, so only its completion needs bindContext
        if (req.method !== "GET" && req.method !== "HEAD") {
            if (options.fallthrough) {
                return next();
            }
            res.statusCode = 405;
            res.setHeader("Allow", "GET, HEAD");
            res.setHeader("Content-Length", "0");
            return res.end();
        }

        const iq = req.url.indexOf("?");
        let url;
        // before decoding: whether it names a directory is decided on this, as send does. "/a/%2F"
        // asks for a file called "/" inside "a"
        const rawPath = iq !== -1 ? req.url.substring(0, iq) : req.url;

        try {
            url = decodeURIComponent(rawPath);
        } catch (e) {
            // a 400 as send answers it
            if (!options.fallthrough) {
                res.status(400);
                return next(httpError(400));
            } else return next();
        }
        // a decoded NUL is a 400 as in send: reaching fs it came back as node's error with the
        // absolute root path inside
        if (url.indexOf("\0") !== -1) {
            if (!options.fallthrough) {
                res.status(400);
                return next(httpError(400));
            } else return next();
        }
        let _path = url;
        // Joined against the root, not normalised alone: a ".." must climb relative to the root so
        // the check below sees it leave ("/mount/../package.json"), normalising the url alone clamps
        // it at "/". No trailing separator, statTarget puts it back only where it belongs: linux
        // refuses a file asked for as a directory
        let fullpath = path.join(resolvedRoot, url);
        if (fullpath.length > resolvedRoot.length && fullpath.endsWith(path.sep)) {
            fullpath = fullpath.slice(0, -1);
        }
        // the same file as _path, absolute, for the precompressed lookup
        let filePath = fullpath;
        // The path serve-static hands send, except a bare "/" the request did not write becomes "":
        // a mount whose root is a file must not ask the disk for a directory. Then
        // `normalize(join(root, path))` as send stats it, trailing separator kept
        const mountRelative = rawPath === "/" && !req.endsWithSlash ? "" : url;
        const statTarget = mountRelative.endsWith("/") && !fullpath.endsWith(path.sep) ? fullpath + path.sep : fullpath;
        if (root && !fullpath.startsWith(resolvedRoot)) {
            if (!options.fallthrough) {
                res.status(403);
                return next(httpError(403));
            } else return next();
        }

        // before the stat, as send judges the path before the disk: a hidden segment in a missing
        // path answers the dotfiles rule, not ENOENT. Normalised first, ".." is not a dotfile
        if (containsDotFile(fullpath.slice(resolvedRoot.length).split(/[\\/]/))) {
            const refusal = options.dotfiles === "deny" ? 403 : options.dotfiles === "allow" ? 0 : 404;
            if (refusal !== 0 && !(options.dotfiles === "ignore_files" && !path.basename(url).startsWith("."))) {
                if (!options.fallthrough) {
                    res.status(refusal);
                    return next(httpError(refusal));
                }
                return next();
            }
        }

        let stat;
        // the twin first: when there is one its stat is the only one needed. A path written with a
        // trailing slash keeps the ordinary order
        let twin;
        if (options.preCompressed && !rawPath.endsWith("/") && !req.endsWithSlash) {
            twin = pickPrecompressed(
                filePath,
                req.headers["accept-encoding"],
                twinTtl,
                req.app._settings["stat cache ms"]
            );
            if (twin) {
                stat = twin.stat;
            }
        }
        try {
            if (stat === undefined) {
                stat = cachedStat(statTarget, req.app._settings["stat cache ms"]);
            }
        } catch (err) {
            // send reports the last failed attempt: the extension it tried, or the index inside a
            // path written with a trailing slash
            let statError = err;
            if (rawPath.endsWith("/") && indexList.length > 0) {
                try {
                    findIndexFile(fullpath, indexList);
                } catch (indexError) {
                    statError = indexError;
                }
            }
            const ext = path.extname(fullpath);
            let i = 0;
            // no extension on a directory; on the decoded url, as send tries it
            if (ext === "" && !url.endsWith("/") && options.extensions) {
                while (i < options.extensions.length) {
                    try {
                        stat = fs.statSync(fullpath + "." + options.extensions[i]);
                        _path = url + "." + options.extensions[i];
                        filePath = fullpath + "." + options.extensions[i];
                        break;
                    } catch (extensionError) {
                        statError = extensionError;
                        i++;
                    }
                }
            }
            if (!stat) {
                if (!options.fallthrough) {
                    res.status(404);
                    // the fs error itself with errno, code, syscall and path, as serve-static hands it
                    return next(asStatError(/** @type {HttpError} */ (statError)));
                } else return next();
            }
        }

        // a file asked for with a trailing slash is a 404, ENOTDIR to send; with an index
        // configured the directory branch below reports the missing index instead
        if (req.endsWithSlash && !stat.isDirectory() && indexList.length === 0) {
            if (!options.fallthrough) {
                res.status(404);
                return next(httpError(404));
            }
            return next();
        }

        if (stat.isDirectory() || req.endsWithSlash) {
            if (!req.endsWithSlash) {
                if (options.redirect) {
                    // the query goes along, the leading slashes are collapsed, and the page is
                    // locked down as serve-static locks it: the body names a target the request supplied
                    res.setHeader("Content-Security-Policy", "default-src 'none'");
                    res.setHeader("X-Content-Type-Options", "nosniff");
                    return res.redirect(301, collapseLeadingSlashes(req._originalPath + "/") + req.urlQuery, true);
                } else {
                    if (!options.fallthrough) {
                        res.status(404);
                        return next(httpError(404));
                    } else return next();
                }
            }
            if (indexList.length > 0) {
                let found;
                try {
                    found = findIndexFile(fullpath, indexList);
                } catch (err) {
                    if (!options.fallthrough) {
                        res.status(404);
                        return next(asStatError(/** @type {HttpError} */ (err)));
                    } else return next();
                }
                if (found === null) {
                    // every name was a directory, send's plain 404
                    if (!options.fallthrough) {
                        res.status(404);
                        return next(httpError(404));
                    }
                    return next();
                }
                stat = found.stat;
                _path = path.join(url, found.name);
                filePath = found.candidate;
            } else {
                // a directory with no index is a 404, which fallthrough: false has to say
                if (!options.fallthrough) {
                    res.status(404);
                    return next(httpError(404));
                }
                return next();
            }
        }

        if (options.preCompressed) {
            // whatever is served depended on the header, variant or not
            res.vary("Accept-Encoding");
            const variant =
                twin ??
                pickPrecompressed(
                    filePath,
                    req.headers["accept-encoding"],
                    twinTtl,
                    req.app._settings["stat cache ms"]
                );
            if (variant) {
                _path += variant.suffix;
                stat = variant.stat;
                res.setHeader("Content-Encoding", variant.encoding);
                // the type of the file asked for, not of the .br; sendFile leaves it alone
                const type = mime.lookup(filePath);
                res.type(type || "application/octet-stream");
            }
        }

        options._stat = stat;

        return res.sendFile(
            _path,
            options,
            bindContext((e) => {
                if (e) {
                    next(options.fallthrough && FALLTHROUGH_STATUSES.has(e.status) ? undefined : e);
                }
            })
        );
    };
}

/**
 * A zlib throw as body-parser's 400. zlib reports it twice, so the 'error' a tick later gets a listener.
 *
 * @param {Inflater} inflate
 * @param {HttpError} err what inflate.process threw
 * @returns {HttpError} the same error, carrying its status
 */
function inflateError(inflate, err) {
    inflate.instance?.on?.("error", () => {});
    err.status = 400;
    err.statusCode = 400;
    err.expose = true;
    return err;
}

/**
 * What a Content-Encoding means: the decompressor to run, or the 415 it is refused with.
 *
 * @param {string|undefined} rawContentEncoding
 * @param {any} options the parser's options, read loosely: only inflate is looked at
 * @returns {{inflate?: Inflater|undefined, error?: HttpError}}
 */
function encodingFor(rawContentEncoding, options) {
    if (!options.inflate) {
        const contentEncoding = (rawContentEncoding || "identity").toLowerCase();
        if (contentEncoding !== "identity") {
            return {
                error: bodyError("content encoding unsupported", 415, "encoding.unsupported", {
                    encoding: contentEncoding
                })
            };
        }
        return {};
    }
    const inflate = createInflate(rawContentEncoding);
    if (inflate === false) {
        return {
            error: bodyError('unsupported content encoding "' + rawContentEncoding + '"', 415, "encoding.unsupported", {
                encoding: rawContentEncoding
            })
        };
    }
    return { inflate };
}

/**
 * The decompressor for a Content-Encoding, undefined for identity, false for one nobody knows.
 *
 * @param {string|undefined} contentEncoding
 * @returns {Inflater|false|undefined}
 */
function createInflate(contentEncoding) {
    const encoding = (contentEncoding || "identity").toLowerCase();
    let stream;
    switch (encoding) {
        case "identity":
            return;
        case "deflate":
            stream = new zlib.Inflate();
            break;
        case "gzip":
            stream = new zlib.Gunzip();
            break;
        case "br":
            stream = new zlib.BrotliDecompress();
            break;
        default:
            return false;
    }
    // the flag the final flush passes, so a truncated stream errors instead of resolving empty
    /** @type {Inflater} */ (stream)._finishFlag =
        encoding === "br" ? zlib.constants.BROTLI_OPERATION_FINISH : zlib.constants.Z_FINISH;
    return stream;
}

/**
 * Builds a body parser: whether the request has a body, collecting it within the limit,
 * decompressing, handing the bytes over. The four differ in the type they claim and what they make.
 *
 * @param {string} defaultType the type matched when the caller names none
 * @param {BodyHandler} beforeReturn turns the collected bytes into req.body
 * @param {(options: BodyParserOptions) => void} [checkOptions] what this parser alone checks
 * @param {string} [charsetPolicy] as body-parser draws it: "utf" (json), "urlencoded" (utf-8 and
 *   iso-8859-1), "any" (iconv), undefined for raw
 * @param {boolean} [keepsBuffer] the buffer itself escapes to the application, so no view over uWS memory
 * @returns {(options?: import("./options").BodyParserOptions) => Function} the middleware factory
 */
function createBodyParser(defaultType, beforeReturn, checkOptions, charsetPolicy, keepsBuffer) {
    return function (userOptions) {
        // a copy, the defaults are written into it
        /** @type {import("./options").BodyParserOptions} */
        const options = userOptions && typeof userOptions === "object" ? { ...userOptions } : new NullObject();
        if (options.verify !== undefined && options.verify !== false && typeof options.verify !== "function") {
            throw new TypeError("option verify must be function");
        }
        if (checkOptions) {
            checkOptions(options);
        }
        // bytes.parse only on a string: bytes(1024) formats it to "1KB" and no comparison held
        if (options.limit === undefined || options.limit === null) {
            options.limit = 100 * 1024;
        } else if (typeof options.limit !== "number") {
            // a size it cannot read is refused here, as body-parser 2.3 does: passed along as
            // null it disabled the limit (CVE-2026-12590)
            const parsed = bytes.parse(options.limit);
            if (parsed === null) {
                throw new TypeError(`option limit "${String(options.limit)}" is invalid`);
            }
            options.limit = parsed;
        }

        const limit = /** @type {number} */ (options.limit);
        const defaultCharset = /** @type {string} */ (options.defaultCharset ?? "utf-8");

        if (typeof options.inflate === "undefined") options.inflate = true;
        if (typeof options.type === "undefined") options.type = defaultType;
        if (typeof options.type === "string") {
            if (!options.type.includes("*")) {
                // as written: type-is lowercases the header, not the option
                options.simpleType = options.type;
            }
            options.type = [options.type];
        } else if (typeof options.type !== "function" && !Array.isArray(options.type)) {
            throw new Error("type must be a string, function or an array");
        }
        if (typeof options.defaultCharset === "undefined") options.defaultCharset = "utf-8";

        // whether the bytes escape the callback: raw hands the buffer over, a verify hook may keep it
        const copyBody = keepsBuffer || typeof options.verify === "function";

        // Whether a content-type is one this parser claims, memoised per parser: a wildcard or a
        // list (a plain type took the simpleType shortcut) cost type-is 513ns per request against
        // 4ns memoised. The header is the client's, so the memo has a ceiling. typeis.is, not
        // typeis(req): the caller already established there is a body
        const claimsType = memoizeByString(
            (contentType) => !!typeis.is(contentType, /** @type {string[]} */ (options.type))
        );

        /** @type {string[]|null|undefined} the "body methods" setting, read on the first request */
        let additionalMethods;

        /**
         * @param {Request & {body?: unknown}} req
         * @param {Response} res
         * @param {(err?: unknown) => void} next
         */
        const parserMiddleware = (req, res, next) => {
            // the prologue is synchronous, bindContext waits for the read (1.4us of nothing here)

            // already read, or what body-parser asks on-finished: all arrived and no longer
            // readable. Not readableEnded, which would build the stream
            if (req.bodyRead || (req.complete === true && req.readable === false)) {
                return next();
            }

            // present and undefined, as body-parser's read() leaves it: Apollo answers 500 without
            // the property, tRPC reads the body itself when it is set
            if (!("body" in req)) {
                req.body = undefined;
            }

            const type = req._rawHeader("content-type");

            // a type function sees a request with no content-type, as body-parser lets it
            if (!type && typeof options.type !== "function") {
                return next();
            }

            const length = req._rawHeader("content-length");
            const lengthNumber = length === undefined ? NaN : +length;

            // no framing at all is no body, which type-is checks and the simpleType shortcut would skip
            if (req._rawHeader("transfer-encoding") === undefined && Number.isNaN(lengthNumber)) {
                return next();
            }

            if (options.simpleType) {
                // only a type function lets a request without a content-type past the check above,
                // and simpleType is never set beside one
                const header = /** @type {string} */ (type);
                const semicolonIndex = header.indexOf(";");
                const clearType = semicolonIndex !== -1 ? header.substring(0, semicolonIndex) : header;
                // the trim and lowercase only when the exact compare fails
                if (clearType !== options.simpleType && clearType.trim().toLowerCase() !== options.simpleType) {
                    return next();
                }
            } else {
                if (typeof options.type === "function") {
                    if (!options.type(req)) {
                        return next();
                    }
                } else {
                    if (!claimsType(/** @type {string} */ (type))) {
                        return next();
                    }
                }
            }

            // the charset before anything is read, in body-parser's order: what this parser
            // accepts, then the Content-Encoding, then whether iconv knows it
            /** @type {string|undefined} */
            let encoding;
            if (charsetPolicy) {
                encoding = charsetOf(type) ?? defaultCharset;
                if (
                    (charsetPolicy === "utf" && encoding.slice(0, 4) !== "utf-") ||
                    (charsetPolicy === "urlencoded" && encoding !== "utf-8" && encoding !== "iso-8859-1")
                ) {
                    return next(charsetError(encoding));
                }
            }

            const encoded = encodingFor(req._rawHeader("content-encoding"), options);
            if (encoded.error) {
                return next(encoded.error);
            }
            const inflate = encoded.inflate;

            if (encoding !== undefined && !BUFFER_CHARSETS.has(encoding) && !loadIconv().encodingExists(encoding)) {
                return next(charsetError(encoding));
            }

            // an empty body still produces the parser's empty value, verify hook first
            if (lengthNumber === 0) {
                req.bodyRead = true;
                /** @type {Buffer<ArrayBufferLike>} zlib's tail is wider */
                let empty = Buffer.alloc(0);
                if (inflate) {
                    // nothing to inflate is a stream cut short, a 400 to body-parser
                    try {
                        empty = inflate.process(EMPTY_BUFFER, inflate._finishFlag);
                    } catch (e) {
                        return next(inflateError(inflate, /** @type {HttpError} */ (e)));
                    }
                }
                if (!runVerify(req, res, next, options, empty, encoding)) {
                    return;
                }
                return beforeReturn(req, res, next, options, empty, encoding);
            }

            // not while inflating: content-length counts the compressed bytes, keepChunk counts the rest
            if (!inflate && lengthNumber > limit) {
                return next(
                    bodyError("request entity too large", 413, "entity.too.large", {
                        expected: lengthNumber,
                        length: lengthNumber,
                        limit: limit
                    })
                );
            }

            // no body read for the verbs that carry none, +10k req/s
            if (additionalMethods === undefined) additionalMethods = req.app.get("body methods") ?? null;
            if (
                req.method !== "POST" &&
                req.method !== "PUT" &&
                req.method !== "PATCH" &&
                req.method !== "QUERY" &&
                (!additionalMethods || !additionalMethods.includes(req.method))
            ) {
                return next();
            }

            let totalSize = 0;

            // uWS delivers the body on native callbacks with no async context
            next = bindContext(next);

            // with nothing to decompress uWS collects the whole body natively: one callback, the
            // limit enforced before any byte reaches JS, no copy
            const declared = lengthNumber;
            const declaresLength = !Number.isNaN(declared) && declared > 0;
            if (!req.receivedData && !inflate && req._res.collectBody && (declaresLength || isNaN(declared))) {
                req.bodyRead = true;
                // the Readable never runs, and a later parser asks it
                req.complete = true;
                req.readable = false;
                req._res.collectBody(limit, (/** @type {ArrayBuffer|null} */ body) => {
                    if (body === null) {
                        // over maxSize: uWS refused it natively
                        return next(
                            bodyError("request entity too large", 413, "entity.too.large", {
                                limit: limit,
                                received: limit
                            })
                        );
                    }
                    if (declaresLength && body.byteLength !== declared) {
                        return next(
                            bodyError("request size did not match content length", 400, "request.size.invalid", {
                                expected: declared,
                                length: declared,
                                received: body.byteLength
                            })
                        );
                    }
                    let buf = Buffer.from(body);
                    if (copyBody) {
                        buf = Buffer.from(buf);
                    }
                    if (!runVerify(req, res, next, options, buf, encoding)) {
                        return;
                    }
                    beforeReturn(req, res, next, options, buf, encoding);
                });
                return;
            }

            // every chunk is copied out of uWS's neutered ArrayBuffer; with a content-length the
            // chunks go straight into one buffer instead of a concat
            /** @type {Buffer[]} */
            const abs = [];
            const declaredLength = inflate ? -1 : Number(length);
            let target =
                declaredLength > 0 && declaredLength <= MAX_PREALLOCATED_BODY
                    ? Buffer.allocUnsafe(declaredLength)
                    : null;
            let targetOffset = 0;

            req.bodyRead = true;

            // uWS keeps delivering chunks after an oversized body was refused
            let finished = false;

            /**
             * A zlib throw as body-parser's 400, what was kept of the body dropped.
             *
             * @param {HttpError} err what inflate.process threw
             */
            function failInflate(err) {
                finished = true;
                abs.length = 0;
                target = null;
                next(inflateError(/** @type {Inflater} */ (inflate), err));
            }

            /**
             * Counts a chunk against the limit and keeps it; false once the limit answered the request.
             *
             * @param {Buffer} buf
             * @returns {boolean}
             */
            function keepChunk(buf) {
                totalSize += buf.length;
                if (totalSize > limit) {
                    finished = true;
                    abs.length = 0;
                    target = null;
                    next(
                        bodyError("request entity too large", 413, "entity.too.large", {
                            limit: limit,
                            received: totalSize
                        })
                    );
                    return false;
                }

                if (target) {
                    if (targetOffset + buf.length <= target.length) {
                        buf.copy(target, targetOffset);
                        targetOffset += buf.length;
                        return true;
                    }
                    // more body than content-length promised
                    abs.push(Buffer.from(target.subarray(0, targetOffset)));
                    target = null;
                }

                abs.push(Buffer.from(buf));
                return true;
            }

            /**
             * One chunk from uWS: decompressed, counted, kept.
             *
             * @param {Buffer|ArrayBuffer} buf a Buffer, or an ArrayBuffer straight from uWS
             */
            function onData(buf) {
                if (finished) {
                    return;
                }
                if (!Buffer.isBuffer(buf)) {
                    buf = Buffer.from(buf);
                }
                if (inflate) {
                    try {
                        buf = inflate.process(buf);
                    } catch (e) {
                        return failInflate(/** @type {HttpError} */ (e));
                    }
                }

                keepChunk(buf);
            }

            /** The body is complete: assemble it, hand it to the parser and continue routing. */
            function onEnd() {
                if (finished) {
                    return;
                }
                finished = true;
                if (inflate) {
                    // the finish pass tells a truncated stream, a 400 to body-parser
                    let tail;
                    try {
                        tail = inflate.process(EMPTY_BUFFER, inflate._finishFlag);
                    } catch (e) {
                        return failInflate(/** @type {HttpError} */ (e));
                    }
                    if (tail.length && !keepChunk(tail)) {
                        return;
                    }
                }
                // fewer bytes than content-length promised; not when inflating, it counts the compressed ones
                if (!inflate && !Number.isNaN(lengthNumber) && totalSize !== lengthNumber) {
                    return next(
                        bodyError("request size did not match content length", 400, "request.size.invalid", {
                            expected: lengthNumber,
                            length: lengthNumber,
                            received: totalSize
                        })
                    );
                }
                const buf = target
                    ? targetOffset === target.length
                        ? target
                        : target.subarray(0, targetOffset)
                    : abs.length === 1
                      ? abs[0]
                      : Buffer.concat(abs);
                if (!runVerify(req, res, next, options, buf, encoding)) {
                    return;
                }
                beforeReturn(req, res, next, options, buf, encoding);
            }

            // straight from uWS unless the stream already started
            if (!req.receivedData) {
                req._res.onData((/** @type {ArrayBuffer} */ ab, /** @type {boolean} */ isLast) => {
                    onData(ab);
                    if (isLast) {
                        // this replaced the Readable's own subscription, so it never ends by itself
                        req.complete = true;
                        req.readable = false;
                        onEnd();
                    }
                });
            } else {
                req.on("data", onData);
                req.on("end", onEnd);
            }
        };
        // a request declaring no body leaves through the synchronous exit before any header is
        // read, so the header-skip analysis may trust it; a type function sees the request
        if (typeof options.type !== "function") {
            parserMiddleware[kGetSafe] = true;
        }
        return parserMiddleware;
    };
}

const json = createBodyParser(
    "application/json",
    function (req, res, next, options, buf, encoding) {
        if (buf.length === 0) {
            req.body = {};
            return next();
        }
        // a byte order mark is stripped as iconv strips it for body-parser
        const text = stripBom(decodeBody(buf, /** @type {string} */ (encoding)));

        // strict: only an object or an array is a body
        if (options.strict !== false) {
            // exactly the four characters body-parser skips, space, tab, LF and CR, scanned rather
            // than matched: its regex allocated a match array per body
            let at = 0;
            let code = text.charCodeAt(0);
            while (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
                code = text.charCodeAt(++at);
            }
            const first = at < text.length ? text[at] : undefined;
            if (first !== "{" && first !== "[") {
                // a SyntaxError, as body-parser builds it
                return next(
                    asBodyError(new SyntaxError(strictSyntaxMessage(text, first)), 400, "entity.parse.failed", {
                        body: text
                    })
                );
            }
        }

        try {
            req.body = JSON.parse(text, options.reviver);
        } catch (e) {
            // V8's own SyntaxError, as body-parser hands it on
            const err = /** @type {SyntaxError} */ (e);
            return next(asBodyError(err, 400, "entity.parse.failed", { body: text }));
        }

        next();
    },
    undefined,
    // json is a utf-* body or nothing, as body-parser reads RFC 7159
    "utf"
);

const raw = createBodyParser(
    "application/octet-stream",
    function (req, res, next, options, buf) {
        req.body = buf;
        next();
    },
    undefined,
    undefined,
    true
);

const text = createBodyParser(
    "text/plain",
    function (req, res, next, options, buf, encoding) {
        try {
            req.body = decodeBody(buf, /** @type {string} */ (encoding));
        } catch (e) {
            return next(e);
        }

        next();
    },
    undefined,
    "any"
);

// body-parser's numbers for qs on an extended body
const EXTENDED_QS_OPTIONS = { allowPrototypes: true, arrayLimit: 100, depth: 32, strictDepth: true };

/**
 * How many parameters a urlencoded body holds, undefined past the limit; counted before parsing.
 *
 * @param {string} body
 * @param {number} limit
 * @returns {number|undefined}
 */
function parameterCount(body, limit) {
    let count = 0;
    let index = 0;
    while ((index = body.indexOf("&", index)) !== -1) {
        count++;
        index++;
        if (count === limit) {
            return undefined;
        }
    }
    return count;
}

const urlencoded = createBodyParser(
    "application/x-www-form-urlencoded",
    function (req, res, next, options, buf, encoding) {
        try {
            const body = decodeBody(buf, /** @type {string} */ (encoding));
            // Express 5 defaults extended to false
            const extended = typeof options.extended !== "undefined" ? options.extended : false;
            // qs alone knows a charset other than utf-8 and the sentinel options
            const needsQs = encoding !== "utf-8" || options.charsetSentinel || options.interpretNumericEntities;
            if (!extended && !needsQs) {
                // the vendored parser, the limit enforced inside its scan
                const parsed = parseQuery(body, undefined, options.parameterLimit);
                if (parseQuery.overflow === true) {
                    return next(bodyError("too many parameters", 413, "parameters.too.many"));
                }
                req.body = parsed;
            } else {
                const count = parameterCount(body, /** @type {number} */ (options.parameterLimit));
                if (count === undefined) {
                    return next(bodyError("too many parameters", 413, "parameters.too.many"));
                }
                if (extended) {
                    // body-parser's ceiling for qs: the array limit rises to the parameter count
                    const qsOptions = {
                        ...EXTENDED_QS_OPTIONS,
                        depth: options.depth !== undefined ? options.depth : 32,
                        arrayLimit: Math.max(100, count + 1),
                        charsetSentinel: options.charsetSentinel,
                        interpretNumericEntities: options.interpretNumericEntities,
                        charset: /** @type {"utf-8"|"iso-8859-1"} */ (encoding),
                        parameterLimit: options.parameterLimit
                    };
                    req.body = needsQs
                        ? Object.assign(Object.create(null), qs.parse(body, qsOptions))
                        : fastQueryParse(body, qsOptions);
                } else {
                    // body-parser's extended: false is still qs, depth 0
                    req.body = Object.assign(
                        Object.create(null),
                        qs.parse(body, {
                            allowPrototypes: true,
                            arrayLimit: count + 1,
                            depth: 0,
                            strictDepth: true,
                            charsetSentinel: options.charsetSentinel,
                            interpretNumericEntities: options.interpretNumericEntities,
                            charset: /** @type {"utf-8"|"iso-8859-1"} */ (encoding),
                            parameterLimit: options.parameterLimit
                        })
                    );
                }
            }
        } catch (e) {
            // qs's depth overflow is a RangeError, a 400 to body-parser
            if (e instanceof RangeError) {
                return next(bodyError("The input exceeded the depth", 400, "querystring.parse.rangeError"));
            }
            return next(e);
        }
        next();
    },
    function (options) {
        const limit = options.parameterLimit !== undefined ? options.parameterLimit : 1000;
        if (isNaN(limit) || limit < 1) {
            throw new TypeError("option parameterLimit must be a positive number");
        }
        // truncated as body-parser truncates it
        options.parameterLimit = isFinite(limit) ? limit | 0 : limit;
        // depth is validated only when extended will use it, as body-parser does
        if (typeof options.extended !== "undefined" ? options.extended : false) {
            const depth = options.depth !== undefined ? options.depth : 32;
            if (isNaN(depth) || depth < 0) {
                throw new TypeError("option depth must be a zero or a positive number");
            }
        }
    },
    "urlencoded"
);

module.exports = {
    static: serveStatic,
    json,
    raw,
    text,
    urlencoded
};
