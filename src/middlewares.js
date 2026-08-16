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
const parseQuery = require("./parse-query.js");
const { kGetSafe } = require("./usage.js");
const { AsyncResource } = require("async_hooks");
const {
    fastQueryParse,
    NullObject,
    asStatError,
    httpError,
    memoizeByString,
    containsDotFile,
    negotiateEncoding,
    cachedStat,
    ENCODING_BR,
    ENCODING_GZIP
} = require("./utils.js");

// largest content-length we will allocate a body buffer for up front. above this the body is
// collected chunk by chunk instead, so a declared-but-unsent body cannot pin more memory than a
// real one of the same size would
const MAX_PREALLOCATED_BODY = 1024 * 1024;

// what the finish pass feeds zlib: no bytes, only the flush flag
const EMPTY_BUFFER = Buffer.alloc(0);

// What express.static serves instead of the file itself when preCompressed is on and the client
// takes it: the suffix nginx, brotli_static and every build tool that writes these agree on.
// Ordered by what is worth having, and negotiation decides between them.
const PRECOMPRESSED = [
    { encoding: "br", suffix: ".br", flag: ENCODING_BR },
    { encoding: "gzip", suffix: ".gz", flag: ENCODING_GZIP }
];

// The failures express.static answers by moving on to the next handler rather than by reporting
// them, when fallthrough is on. They all mean the same thing: the request is not a file here.
//
// serve-static decides this by remembering whether send got as far as settling on a file, and
// forwards everything after that point. The list is the same thing said from the other side, since
// by the time this hands over, the file has been found and stat'ed already: what is left to fail
// is a dotfile rule or a path that will not decode.
//
// A 412 and a 416 are not on it, and that is the point of the list. Both are about a file that
// exists and about conditions the client itself set, and falling through swallowed them: a Range
// Not Satisfiable came back as a 404, which tells the client its file is gone when it is not.
const FALLTHROUGH_STATUSES = new Set([400, 403, 404]);

/**
 * A path with any run of leading slashes reduced to one.
 *
 * This is not tidiness. A Location header beginning with "//" is a protocol-relative URL, so a
 * browser given "//assets/" goes to the host called "assets" rather than to a path on this server.
 * serve-static collapses them for exactly that reason, and a redirect that leaves the server is
 * not a redirect the server meant to issue.
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
 * The text without a leading byte order mark, which is what a decoder would have handed over.
 * body-parser decodes through iconv and iconv removes it, so nothing downstream of it ever sees
 * one; reading the buffer directly, as here, means removing it explicitly.
 *
 * @param {string} text
 * @returns {string}
 */
function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

let iconv;

/**
 * iconv-lite, loaded only when a request names a charset the Buffer cannot decode, so the common
 * utf-8 request never pays for it.
 *
 * @returns {any}
 */
function loadIconv() {
    if (!iconv) iconv = require("iconv-lite");
    return iconv;
}

// charsets decoded straight through the Buffer, without iconv
const BUFFER_CHARSETS = new Set(["utf-8", "utf-16le", "latin1", "iso-8859-1"]);

/**
 * The charset parameter of a content-type, trimmed and lowercased, or undefined when there is
 * none. The value may be quoted, and the quotes are not part of the charset.
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
        // parameter names are case-insensitive; the lowercase spelling is the fast path, and any
        // other is only looked for when the type carries parameters at all
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
 * The body decoded under a charset: through the Buffer when node knows the name, through
 * iconv-lite otherwise. iconv strips a byte order mark on its own; the Buffer paths keep it,
 * which is why the json parser strips it separately.
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
            return loadIconv().decode(buf, encoding);
    }
}

/**
 * Runs the caller's verify hook the way body-parser does, an empty body included; a throw becomes
 * the 403 entity.verify.failed error. Answers whether parsing may continue.
 *
 * @param {any} req
 * @param {any} res
 * @param {(err?: any) => void} next
 * @param {any} options
 * @param {Buffer} buf
 * @returns {boolean}
 */
function runVerify(req, res, next, options, buf) {
    if (!options.verify) {
        return true;
    }
    try {
        options.verify(req, res, buf);
        return true;
    } catch (e) {
        const err = /** @type {any} */ (e);
        next(
            bodyError(err.message, err.status ?? err.statusCode ?? 403, err.type ?? "entity.verify.failed", {
                body: buf,
                stack: err.stack
            })
        );
        return false;
    }
}

/**
 * The message a strict violation gets, which is the one V8 would have produced had the body been
 * invalid JSON rather than merely not an object.
 *
 * body-parser goes to some trouble over this: it builds a string that is the body up to the
 * offending character followed by placeholder characters, asks JSON.parse to fail on that, and
 * then puts the real characters back into whatever V8 said. The point is that an application
 * showing err.message reads the same sentence either way, naming the character and its position.
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
        // put the real characters back where the placeholders were named
        return /** @type {any} */ (e).message.replace(/#+/g, (/** @type {string} */ placeholder) =>
            text.substring(index, index + placeholder.length)
        );
    }
    return "strict violation";
}

/**
 * The error a body parser hands to next(), shaped as body-parser shapes it: with a status, since
 * `res.status(err.status || 500)` would otherwise answer 500 to a request that was merely too
 * large, and with `type`, which applications branch on.
 *
 * @param {string} message
 * @param {number} status
 * @param {string} type body-parser's own name for the kind of failure
 * @param {object} [extra] anything else body-parser puts on that particular error
 * @returns {Error}
 */
function bodyError(message, status, type, extra) {
    const err = /** @type {any} */ (new Error(message));
    // 4xx is the client's to see; a 5xx here would be the server's own problem and stays hidden
    err.expose = status < 500;
    err.statusCode = status;
    err.status = status;
    err.type = type;
    return Object.assign(err, extra);
}

/**
 * Whether a file of this extension is one anybody writes a `.br` or a `.gz` next to. A webp or a
 * woff2 is already compressed and never has a twin, and looking for one costs two stats on a
 * request that could not have used it: on a mixed directory that is most of the stat time. An
 * extension nothing knows is looked up anyway, since it might well be text.
 *
 * @param {string} extension including the dot, or "" for a name without one
 * @returns {boolean}
 */
const hasTwins = memoizeByString((extension) => {
    const type = mime.lookup(extension);
    return type ? compressible(type) === true : true;
});

// Which twins a path has, remembered for a moment. What is cached is only whether they are there,
// never their size or their mtime: those decide the ETag, the Last-Modified and the length, so they
// are read fresh on every request and a file that changed is never described by a stale number.
// The worst a stale entry can do is serve the file where it could have served the twin, or look for
// a twin that has just been deleted and fall back. nginx's open_file_cache is the same trade.
const twinCache = new Map();
const TWIN_CACHE_LIMIT = 4096;

/**
 * What is known about a path's twins right now, as a record to fill in.
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
    // cleared rather than evicted one by one, as memoizeByString does: this holds one small object
    // per path served, and a directory big enough to reach the limit is being served by something
    // other than an application server anyway
    if (twinCache.size >= TWIN_CACHE_LIMIT) {
        twinCache.clear();
    }
    twinCache.set(filePath, entry);
    return entry;
}

/**
 * The compressed twin of a file to serve in its place, or undefined when the client would rather
 * have the file itself or the twin is not there.
 *
 * The stat comes back with it, and is what sendFile then answers from: the ETag and the
 * Last-Modified of a variant are its own, which is the whole point. Two bodies sharing one ETag is
 * how a shared cache ends up handing brotli to a client that cannot read it.
 *
 * One stat when the answer is a twin, and none at all when the last request already found there is
 * no twin to have. See twinCache above for what is remembered and what is not.
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
    // twice at most: the second pass is the case where brotli won and there is no .br on disk
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
                // not on disk, which is the ordinary case for a file nobody precompressed
            }
            if (known !== undefined) known[variant.encoding === "br" ? "br" : "gz"] = false;
        }
        allowed &= ~variant.flag;
    }
    return undefined;
}

/**
 * express.static, which is a thin front for res.sendFile: it resolves the path, refuses anything
 * that climbs out of the root, applies the dotfiles and index rules, and hands the rest over.
 *
 * @param {string} root directory to serve from
 * @param {import("./options").StaticOptions} [options]
 * @returns {(req: any, res: any, next: (err?: any) => void) => any}
 */
function serveStatic(root, options) {
    // serve-static's own messages, thrown where the middleware is written rather than where a
    // request arrives, since a root that is not a path can never serve anything
    if (!root) {
        throw new TypeError("root path required");
    }
    if (typeof root !== "string") {
        throw new TypeError("root path must be a string");
    }
    // a copy, as serve-static's Object.create(options): everything below writes into it, and two
    // mounts sharing one options object would otherwise also share one root
    options = Object.assign(new NullObject(), options);
    if (typeof options.index === "undefined") options.index = "index.html";
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
    // How long express.static remembers which twins a path has. A second is short enough that a
    // deploy is picked up while it is still going out, and long enough that the lookup costs
    // nothing under any traffic at all. { cache: false } asks the disk on every request.
    let twinTtl = 0;
    if (options.preCompressed) {
        const cache = /** @type {any} */ (
            typeof options.preCompressed === "object" ? options.preCompressed.cache : undefined
        );
        twinTtl =
            cache === undefined
                ? 1000
                : cache === false
                  ? 0
                  : typeof cache === "string"
                    ? ms(/** @type {any} */ (cache))
                    : cache;
        if (typeof twinTtl !== "number" || !(twinTtl >= 0)) {
            throw new TypeError("option preCompressed.cache must be a duration");
        }
    }
    options.root = root;
    // resolved once here rather than on every request: the root cannot change under a mount
    const resolvedRoot = path.resolve(root);
    // serve-static decides this for itself and never asks the app, so a static file keeps its
    // ETag under app.set("etag", false) and only { etag: false } here turns it off. res.sendFile
    // takes the app's setting instead, which is why this has to be said out loud.
    options.etag = options.etag !== false;
    options._ownEtag = true;

    return (req, res, next) => {
        // Not bound here: every path down to sendFile is synchronous, statSync included, so the
        // caller's async context is intact at each of these next() calls. Only sendFile's
        // completion can arrive on a uWS callback that carries no context, and that one
        // continuation is bound where it is handed over.

        // a file is read, not written: anything but GET and HEAD belongs to whoever comes next, or
        // is refused outright when this middleware is the last word
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
        // the path as it was written, before decoding: whether it names a directory is decided on
        // this and not on what the escapes turn into, which is how send decides it. "/a/%2F" asks
        // for a file called "/" inside "a", and not for the index of a directory
        const rawPath = iq !== -1 ? req.url.substring(0, iq) : req.url;

        try {
            url = decodeURIComponent(rawPath);
        } catch (e) {
            // 400 and not 404: send answers a path it cannot decode with a Bad Request, since
            // nothing was asked for that could be missing
            if (!options.fallthrough) {
                res.status(400);
                return next(httpError(400));
            } else return next();
        }
        // A decoded NUL is a bad request and not a missing file, which is how send reads it too.
        // Without this the byte reaches fs, and what comes back is node's own complaint with the
        // absolute path of the root inside it, so a request could ask the server where it lives.
        if (url.indexOf("\0") !== -1) {
            if (!options.fallthrough) {
                res.status(400);
                return next(httpError(400));
            } else return next();
        }
        let _path = url;
        // Joined against the root and not normalised on its own first, which is the difference
        // between "/mount/../package.json" being refused and being served: a ".." has to climb
        // relative to the root so the check below can see it leave, and normalizing the url alone
        // clamps it at "/" where nothing has left anywhere. Absolute because resolvedRoot is, so
        // nothing here resolves against the working directory per request either.
        // and without the trailing separator join keeps and resolve does not, because statTarget
        // below puts it back only where it belongs: linux refuses a file asked for as a directory,
        // so a mount whose root is a file answers nothing at all if the separator stays here.
        // Windows stats it either way, which is why only the CI said so.
        let fullpath = path.join(resolvedRoot, url);
        if (fullpath.length > resolvedRoot.length && fullpath.endsWith(path.sep)) {
            fullpath = fullpath.slice(0, -1);
        }
        // the same file as _path, absolute: the two move together through the index and extension
        // rules below, and only the precompressed lookup needs the absolute one
        let filePath = fullpath;
        // What serve-static hands send is this path, except that a bare "/" under a mount the
        // request did not write with one becomes "": without that rule a mount whose root is a file
        // would ask the disk for a directory and could never answer at all.
        //
        // Send then stats `normalize(join(root, path))`, and both of those keep a trailing
        // separator where `resolve` takes it off. The separator is not decoration: the disk refuses
        // a file that is asked for as a directory, and the name inside the error carries it, which
        // is what an error handler prints when fallthrough is off.
        const mountRelative = rawPath === "/" && !req.endsWithSlash ? "" : url;
        const statTarget = mountRelative.endsWith("/") && !fullpath.endsWith(path.sep) ? fullpath + path.sep : fullpath;
        if (root && !fullpath.startsWith(resolvedRoot)) {
            if (!options.fallthrough) {
                res.status(403);
                return next(httpError(403));
            } else return next();
        }

        // Before the stat, because send judges the path before it looks at the disk: a hidden
        // segment anywhere in a path that does not exist answers what the dotfiles rule says and
        // not the ENOENT the disk would have given. sendFile applies the same rule below, and
        // reaches it only for paths that do exist.
        // normalized first, as send normalizes before it judges: a ".." segment is not a hidden
        // file, and resolving it away is what tells the two apart
        // and these are the segments path.normalize(url) would have produced, taken off the joined
        // path rather than walked again: the check above has just proved it starts with the root,
        // so what follows the root is the url in normal form
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
        // The twin, looked for before the file itself rather than after it. When there is one, it
        // is the file being served and its stat is the only one this request needs: the request
        // that asks for /app.js and gets /app.js.br has no use for /app.js's size or mtime. A
        // directory, or a path written with a trailing slash, keeps the ordinary order, since what
        // decides those is the stat of the thing that was asked for.
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
            // the one to report when nothing is found: send hands each failed attempt to the next
            // one and reports whichever came last, so an extensions option that also missed names
            // the file it looked for and not the bare path
            let statError = err;
            // a path written with a trailing slash asks for a directory, and send answers that by
            // looking for the index inside it. With nothing there, the file it names is that
            // index and not the directory that does not exist either
            if (rawPath.endsWith("/") && options.index) {
                try {
                    fs.statSync(path.join(fullpath, options.index));
                } catch (indexError) {
                    statError = indexError;
                }
            }
            const ext = path.extname(fullpath);
            let i = 0;
            // a path that resolves to a directory gets no extension hung off it. The test is on the
            // decoded url and not on fullpath, because resolve() has already taken the trailing
            // separator off that one, and not on the raw path either: send tries the extension on
            // what the escapes decoded to, while it looks for an index on the path as written
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
                    // the error itself, not its message: serve-static hands the fs error to the
                    // error handler with its errno, code, syscall and path still on it, and an
                    // error handler doing res.send(err) sends those as JSON. Passing the string
                    // sent an HTML page instead.
                    return next(asStatError(statError));
                } else return next();
            }
        }

        // a file asked for with a trailing slash is not that file: send stats the path slash and
        // all and gets ENOTDIR, so a root mounted as a file answers 404 there, not the file
        if (req.endsWithSlash && !stat.isDirectory()) {
            if (!options.fallthrough) {
                res.status(404);
                return next(httpError(404));
            }
            return next();
        }

        if (stat.isDirectory()) {
            if (!req.endsWithSlash) {
                if (options.redirect) {
                    // The query goes along, and the leading slashes are collapsed. Both were
                    // wrong: "/docs?page=3" redirected to "/docs/" and lost the page, and a
                    // request for "//assets" answered "Location: //assets/", which a browser
                    // reads as a protocol-relative URL and follows to the host "assets". A
                    // redirect that leaves this server is not a redirect this server meant.
                    // serve-static locks its redirect page down the way it locks an error page:
                    // the body names the target, and the target came from the request
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
            if (options.index) {
                try {
                    stat = fs.statSync(path.join(fullpath, options.index));
                    _path = path.join(url, options.index);
                    filePath = path.join(fullpath, options.index);
                } catch (err) {
                    if (!options.fallthrough) {
                        res.status(404);
                        // the fs error, as above: the index file is missing and the error handler
                        // is told which one and where
                        return next(asStatError(err));
                    } else return next();
                }
            } else {
                // a directory with no index to serve is a Not Found, and saying so is the whole
                // point of fallthrough: false. This moved on to the next handler instead, so the
                // application's own 404 answered where serve-static's error handler should have.
                if (!options.fallthrough) {
                    res.status(404);
                    return next(httpError(404));
                }
                return next();
            }
        }

        if (options.preCompressed) {
            // whatever is served, the answer depended on the header, so a shared cache has to be
            // told. Said before the lookup, because it is true even when there is no variant
            res.vary("Accept-Encoding");
            // already found before the stat below, on the ordinary path
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
                // from the name of the file that was asked for, since the one being sent ends in
                // .br and nothing would call that javascript. sendFile leaves a content-type that
                // is already there alone, which is what makes this the deciding one
                const type = mime.lookup(filePath);
                res.type(type || "application/octet-stream");
            }
        }

        options._stat = stat;

        return res.sendFile(
            _path,
            options,
            AsyncResource.bind((e) => {
                if (e) {
                    next(options.fallthrough && FALLTHROUGH_STATUSES.has(e.status) ? undefined : e);
                }
            })
        );
    };
}

/**
 * The decompressor for a Content-Encoding, or undefined when the body is not compressed. An
 * encoding nobody knows throws, since decoding it wrong is worse than refusing.
 *
 * @param {string|undefined} contentEncoding
 * @returns {any|undefined}
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
    /** @type {any} */ (stream)._finishFlag =
        encoding === "br" ? zlib.constants.BROTLI_OPERATION_FINISH : zlib.constants.Z_FINISH;
    return stream;
}

/**
 * Builds one of the body parsers. All four share the same work, which is deciding whether this
 * request has a body worth reading, collecting it within the size limit, decompressing it and
 * handing the bytes over; they differ only in the content type they claim by default and in what
 * they turn the bytes into.
 *
 * @param {string} defaultType the type matched when the caller names none
 * @param {(...args: any[]) => any} beforeReturn turns the collected bytes into req.body. Called
 *   with the request, the response, next, the options, the body and its charset
 * @param {(options: any) => void} [checkOptions] whatever this parser alone has to check
 * @param {string} [charsetPolicy] which charsets this parser accepts, as body-parser draws the
 *   lines: "utf" (json, utf-* only), "urlencoded" (utf-8 and iso-8859-1), "any" (anything iconv
 *   knows), or undefined for a parser that never decodes (raw)
 * @param {boolean} [keepsBuffer] whether the collected buffer itself escapes to the application,
 *   which rules out handing it a view over uWS memory
 * @returns {(options?: import("./options").BodyParserOptions) => Function} the middleware factory
 */
function createBodyParser(defaultType, beforeReturn, checkOptions, charsetPolicy, keepsBuffer) {
    return function (userOptions) {
        // a copy, because everything below writes the parsed values back: with the caller's own
        // object, altering it after the parser was built would alter the parser. The type says
        // settled because the block below fills in every default, which is what the middleware
        // and its closures then rely on
        /** @type {import("./options").BodyParserOptions} */
        const options = userOptions && typeof userOptions === "object" ? { ...userOptions } : new NullObject();
        // refused where it is written, not where it is used: an option nobody can honour is a
        // mistake in the application, and body-parser throws for it at the same point
        if (options.verify !== undefined && options.verify !== false && typeof options.verify !== "function") {
            throw new TypeError("option verify must be function");
        }
        if (checkOptions) {
            checkOptions(options);
        }
        // bytes() goes both ways: given a number it formats it, so bytes(1024) is the string "1KB"
        // and every comparison against it is false. express.json({ limit: 5 * 1024 * 1024 }) had no
        // limit at all. parse, and only what needs parsing
        if (typeof options.limit === "undefined") {
            options.limit = /** @type {number} */ (bytes.parse("100kb"));
        } else if (typeof options.limit !== "number") {
            // bytes.parse answers null for a size it cannot read, and body-parser passes that
            // along untouched too: matching it matters more than improving on it here
            options.limit = /** @type {number} */ (bytes.parse(options.limit));
        }

        // settled above, and read once: every check below wants the value, not the bag
        const limit = /** @type {number} */ (options.limit);
        const defaultCharset = /** @type {string} */ (options.defaultCharset ?? "utf-8");

        if (typeof options.inflate === "undefined") options.inflate = true;
        if (typeof options.type === "undefined") options.type = defaultType;
        if (typeof options.type === "string") {
            if (!options.type.includes("*")) {
                // kept as written: type-is lowercases the header but not the option, so an option
                // in the wrong case never matches, and the same has to hold here
                options.simpleType = options.type;
            }
            options.type = [options.type];
        } else if (typeof options.type !== "function" && !Array.isArray(options.type)) {
            throw new Error("type must be a string, function or an array");
        }
        if (typeof options.defaultCharset === "undefined") options.defaultCharset = "utf-8";

        // whether the collected bytes escape the collection callback: the raw parser hands the
        // buffer itself to the application, and a verify hook may keep what it is shown
        const copyBody = keepsBuffer || typeof options.verify === "function";

        // Whether a content-type is one this parser claims, remembered per parser.
        //
        // Only reached when the caller asked for a wildcard or a list, since a plain type takes the
        // simpleType shortcut above and never calls type-is at all. For those callers type-is was
        // 513 ns to reach the same answer about the same string on every request, against 4 ns for
        // an answer already worked out. The header is the client's, so the memo needs its ceiling.
        //
        // typeis.is and not typeis(req, ...): the request form first checks that there is a body,
        // and the caller below has established that already.
        const claimsType = memoizeByString(
            (contentType) => !!typeis.is(contentType, /** @type {string[]} */ (options.type))
        );

        let additionalMethods;

        const parserMiddleware = (req, res, next) => {
            // Not bound yet: every return in this prologue is synchronous, so the caller's async
            // context is still intact and an AsyncResource here would be 1.4 microseconds of
            // nothing. The bind happens below, only once a real read is about to go async.

            // skip reading body twice
            if (req.bodyRead) {
                return next();
            }

            // straight from the raw entries: three headers do not justify building the object
            const type = req._rawHeader("content-type");

            // req.body is deliberately left undefined until a parser claims the request. That is
            // what lets a handler tell "nothing parsed this" apart from "the body was empty",
            // so it must not be seeded with an empty object first.

            // skip reading body for no content type
            // a function decides for itself, and body-parser lets it see a request that carries no
            // content-type at all. Only the string and array forms need one to match against
            if (!type && typeof options.type !== "function") {
                return next();
            }

            const length = req._rawHeader("content-length");

            // No content-length and no transfer-encoding means the request carries no body at all,
            // and a body parser must leave it alone rather than parse nothing into an empty value.
            // type-is applies this before matching the type, but the simpleType shortcut below
            // compares strings directly and would otherwise skip the check.
            if (req._rawHeader("transfer-encoding") === undefined && isNaN(length)) {
                return next();
            }

            if (options.simpleType) {
                const semicolonIndex = type.indexOf(";");
                const clearType = semicolonIndex !== -1 ? type.substring(0, semicolonIndex) : type;
                // the exact compare stays the fast path; the trim and lowercase only run when it
                // fails, for "Application/JSON" and the legal whitespace before a ";"
                if (clearType !== options.simpleType && clearType.trim().toLowerCase() !== options.simpleType) {
                    return next();
                }
            } else {
                if (typeof options.type === "function") {
                    if (!options.type(req)) {
                        return next();
                    }
                } else {
                    if (!claimsType(type)) {
                        return next();
                    }
                }
            }

            // the charset is settled before anything is read, as body-parser settles it: a bad one
            // answers 415 even for an empty body, and before the verify hook can run
            let encoding;
            if (charsetPolicy) {
                encoding = charsetOf(type) ?? defaultCharset;
                if (
                    (charsetPolicy === "utf" && encoding.slice(0, 4) !== "utf-") ||
                    (charsetPolicy === "urlencoded" && encoding !== "utf-8" && encoding !== "iso-8859-1")
                ) {
                    return next(charsetError(encoding));
                }
                if (!BUFFER_CHARSETS.has(encoding) && !loadIconv().encodingExists(encoding)) {
                    return next(charsetError(encoding));
                }
            }

            // an empty body still has to produce this parser's empty value the way express does -
            // {} for json and urlencoded, '' for text, an empty Buffer for raw - rather than leaving
            // req.body as the placeholder object. there is nothing to read, so run the tail directly,
            // and the verify hook still runs first: webhook signature checks rely on that
            if (Number(length) === 0) {
                req.bodyRead = true;
                const empty = Buffer.alloc(0);
                if (!runVerify(req, res, next, options, empty)) {
                    return;
                }
                return beforeReturn(req, res, next, options, empty, encoding);
            }

            // skip reading too large body
            if (length && +length > limit) {
                return next(
                    bodyError("request entity too large", 413, "entity.too.large", {
                        expected: +length,
                        length: +length,
                        limit: limit
                    })
                );
            }

            // skip reading body for non-POST requests
            // this makes it +10k req/sec faster
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

            const abs = [];
            let inflate;
            let totalSize = 0;
            const rawContentEncoding = req._rawHeader("content-encoding");
            const contentEncoding = (rawContentEncoding || "identity").toLowerCase();
            if (!options.inflate && contentEncoding !== "identity") {
                return next(
                    bodyError("content encoding unsupported", 415, "encoding.unsupported", {
                        encoding: contentEncoding
                    })
                );
            }
            if (options.inflate) {
                inflate = createInflate(rawContentEncoding);
                if (inflate === false) {
                    return next(
                        bodyError(
                            'unsupported content encoding "' + rawContentEncoding + '"',
                            415,
                            "encoding.unsupported",
                            {
                                encoding: rawContentEncoding
                            }
                        )
                    );
                }
            }

            // From here the body really gets read, and uWS delivers it on native callbacks that
            // carry no async context, so this is the one continuation that has to be bound: an
            // upstream middleware's AsyncLocalStorage must still be there when next runs
            next = AsyncResource.bind(next);

            // with nothing to decompress, uWS can collect the whole body in native code: one
            // callback instead of one per chunk, the limit enforced before any byte reaches JS,
            // and no copy at all - the parsers turn the bytes into req.body before the callback
            // returns, so a view over uWS's own memory is enough. A declared length was the
            // original case; a chunked body accumulates in the same native vector and only loses
            // the length check, since there is no declaration to hold it to
            const declared = Number(length);
            const declaresLength = !isNaN(declared) && declared > 0;
            if (!req.receivedData && !inflate && req._res.collectBody && (declaresLength || isNaN(declared))) {
                req.bodyRead = true;
                req._res.collectBody(limit, (body) => {
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
                    if (!runVerify(req, res, next, options, buf)) {
                        return;
                    }
                    beforeReturn(req, res, next, options, buf, encoding);
                });
                return;
            }

            // uWS neuters its ArrayBuffer after the callback, so every chunk has to be copied out of
            // it - and then Buffer.concat copied the whole body a second time. when content-length is
            // known and we aren't inflating, the final size is known up front, so chunks can go
            // straight into one buffer and the body is copied once.
            // the cap means a client that declares a body and never sends it costs no more than one
            // that actually sends a body that size, and content-length above limit was
            // already rejected above
            const declaredLength = inflate ? -1 : Number(length);
            let target =
                declaredLength > 0 && declaredLength <= MAX_PREALLOCATED_BODY
                    ? Buffer.allocUnsafe(declaredLength)
                    : null;
            let targetOffset = 0;

            req.bodyRead = true;

            // uWS keeps delivering chunks after we reject an oversized body, and the
            // stream path still emits 'end', so without this every further chunk would
            // call next() again and the second response would throw
            let finished = false;

            /**
             * A zlib throw becomes the 400 body-parser answers a corrupt body with.
             *
             * zlib reports it twice: process() throws, and the stream emits 'error' a tick
             * later. fast-zlib removes its own listeners on the way out, so that second one
             * lands on nothing, and an unhandled 'error' event ends the process: a corrupt
             * gzip body was enough to take the server down. The listener goes on after the
             * throw, since process() would have removed it.
             *
             * @param {any} err what inflate.process threw
             */
            function failInflate(err) {
                /** @type {any} */ (inflate).instance?.on?.("error", () => {});
                finished = true;
                abs.length = 0;
                target = null;
                err.status = 400;
                err.statusCode = 400;
                err.expose = true;
                next(err);
            }

            /**
             * Counts a decompressed chunk against the limit and keeps it. Answers whether the
             * caller may go on, since passing the limit answers the request right here.
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
                    // more body than content-length promised: keep what we have and fall back
                    abs.push(Buffer.from(target.subarray(0, targetOffset)));
                    target = null;
                }

                // shallow copy, to avoid shared references for large bodies.
                abs.push(Buffer.from(buf));
                return true;
            }

            /**
             * One chunk from uWS. Decompresses it, counts it against the limit and keeps it. The
             * finished flag matters: uWS goes on delivering chunks after an oversized body has
             * been refused, and without it every further chunk would answer the request again.
             *
             * @param {any} buf a Buffer, or an ArrayBuffer straight from uWS
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
                        // a body that does not decompress is the client's mistake, and zlib
                        // throwing here used to escape into whatever called us
                        return failInflate(e);
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
                    // the flush per chunk cannot tell a complete stream from one cut short, so
                    // the finish pass asks zlib outright: a truncated gzip body used to resolve
                    // to whatever bytes had come out, where body-parser answers 400
                    let tail;
                    try {
                        tail = inflate.process(EMPTY_BUFFER, inflate._finishFlag);
                    } catch (e) {
                        return failInflate(e);
                    }
                    if (tail.length && !keepChunk(tail)) {
                        return;
                    }
                }
                // fewer bytes than content-length promised: the request was cut short, and parsing
                // what did arrive would answer as though it were the whole thing. Not when
                // inflating, where content-length counts the compressed bytes and totalSize the
                // ones that came out
                if (!inflate && length !== undefined && !isNaN(length) && totalSize !== Number(length)) {
                    return next(
                        bodyError("request size did not match content length", 400, "request.size.invalid", {
                            expected: Number(length),
                            length: Number(length),
                            received: totalSize
                        })
                    );
                }
                // target holds the whole body already; otherwise a single chunk is the body, and
                // only a genuinely chunked body needs the concat
                const buf = target
                    ? targetOffset === target.length
                        ? target
                        : target.subarray(0, targetOffset)
                    : abs.length === 1
                      ? abs[0]
                      : Buffer.concat(abs);
                if (!runVerify(req, res, next, options, buf)) {
                    return;
                }
                beforeReturn(req, res, next, options, buf, encoding);
            }

            // reading data directly from uWS is faster than from a stream
            // if we are fast enough (not async), we can do it
            // otherwise we need to use a stream since it already started streaming it
            if (!req.receivedData) {
                req._res.onData((ab, isLast) => {
                    onData(ab);
                    if (isLast) {
                        onEnd();
                    }
                });
            } else {
                req.on("data", onData);
                req.on("end", onEnd);
            }
        };
        // A GET without a declared body leaves this middleware through the synchronous
        // no-body exit before anything type- or charset-shaped is read, and a GET that does
        // declare one takes the full header copy in the constructor, so the header-skip
        // analysis may trust it. A type function sees the request itself, so it may not.
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
        // A leading byte order mark is removed rather than parsed. body-parser never sees one
        // either: it decodes through iconv, which strips it, so by the time the first character is
        // looked at the mark is gone. JSON.parse would refuse it, so without this a body saved by
        // an editor that writes a BOM is answered 400 here and 200 by Express.
        const text = stripBom(decodeBody(buf, encoding));

        // "strict" means only an object or an array is a body, which is body-parser's default and
        // was not honoured here at all: the check read req.body before this function had parsed
        // anything, so it looked at the previous request's body and passed. `express.json()`
        // accepted a bare string or number where Express answers 400.
        if (options.strict !== false) {
            // Exactly the four characters body-parser skips, and no more. A BOM or a non-breaking
            // space is not whitespace to it, so a body starting with one is a violation rather than
            // something to skip past, and a wider class here would accept bodies Express refuses.
            // eslint-disable-next-line no-control-regex
            const first = text.match(/^[\x20\x09\x0a\x0d]*([^\x20\x09\x0a\x0d])/)?.[1];
            if (first !== "{" && first !== "[") {
                return next(bodyError(strictSyntaxMessage(text, first), 400, "entity.parse.failed", { body: text }));
            }
        }

        try {
            req.body = JSON.parse(text, options.reviver);
        } catch (e) {
            // the JSON error's own message, which is what body-parser keeps, so an application
            // showing err.message still says where the parse gave up
            const err = /** @type {any} */ (e);
            return next(bodyError(err.message, 400, "entity.parse.failed", { body: text }));
        }

        next();
    },
    undefined,
    // RFC 7159 sec 8.1, as body-parser reads it: json is a utf-* body or nothing
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
    // req.body is the collected buffer itself, so it must not be a view over uWS memory
    true
);

const text = createBodyParser(
    "text/plain",
    function (req, res, next, options, buf, encoding) {
        try {
            req.body = decodeBody(buf, encoding);
        } catch (e) {
            return next(e);
        }

        next();
    },
    undefined,
    // body-parser's text has no allowlist: any charset iconv can decode is a body, and only an
    // unknown one is the 415
    "any"
);

// what qs is given for an extended body, which is not what it is given for a query string: these
// are body-parser's numbers and they bound how much work one request can ask for
const EXTENDED_QS_OPTIONS = { allowPrototypes: true, arrayLimit: 100, depth: 32, strictDepth: true };

/**
 * How many parameters a urlencoded body holds, or undefined once it holds more than the limit.
 * Counted before parsing, so a body with a million keys is refused rather than parsed.
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
            const body = decodeBody(buf, encoding);
            const count = parameterCount(body, options.parameterLimit);
            if (count === undefined) {
                return next(bodyError("too many parameters", 413, "parameters.too.many"));
            }
            // Express 5 defaults extended to false, so nested keys need opting in
            const extended = typeof options.extended !== "undefined" ? options.extended : false;
            // qs has to know the charset itself for anything but utf-8, and the sentinel options
            // change what a parse means, so those bodies skip the fast parsers
            const needsQs = encoding !== "utf-8" || options.charsetSentinel || options.interpretNumericEntities;
            if (extended) {
                // the ceiling body-parser gives qs: the array limit rises to the parameter count,
                // so a form posting 150 array members still yields an array. count counts "&"
                // separators where body-parser counts parameters, hence the + 1
                const qsOptions = {
                    ...EXTENDED_QS_OPTIONS,
                    depth: options.depth !== undefined ? options.depth : 32,
                    arrayLimit: Math.max(100, count + 1),
                    charsetSentinel: options.charsetSentinel,
                    interpretNumericEntities: options.interpretNumericEntities,
                    charset: encoding,
                    parameterLimit: options.parameterLimit
                };
                req.body = needsQs
                    ? Object.assign(Object.create(null), qs.parse(body, qsOptions))
                    : fastQueryParse(body, qsOptions);
            } else if (needsQs) {
                // body-parser's extended: false is still qs, with depth 0 and the count as the
                // array ceiling; only qs decodes latin1 percent escapes as latin1
                req.body = Object.assign(
                    Object.create(null),
                    qs.parse(body, {
                        allowPrototypes: true,
                        arrayLimit: count + 1,
                        depth: 0,
                        strictDepth: true,
                        charsetSentinel: options.charsetSentinel,
                        interpretNumericEntities: options.interpretNumericEntities,
                        charset: encoding,
                        parameterLimit: options.parameterLimit
                    })
                );
            } else {
                // the vendored parser, so an urlencoded body inspects like req.query does
                req.body = parseQuery(body);
            }
        } catch (e) {
            // qs reports a depth overflow as a RangeError with its own wording; body-parser
            // answers it 400, not a raw 500
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
        // truncated the way body-parser truncates it, so parameterLimit 10.1 stops at ten
        options.parameterLimit = isFinite(limit) ? limit | 0 : limit;
        // depth is only qs's to enforce, so body-parser validates it only when extended will use it
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
