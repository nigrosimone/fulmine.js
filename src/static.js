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
const { lazyRequire } = require("./lazy-require.js");
const mime = /** @type {() => typeof import("mime-types")} */ (lazyRequire("mime-types"));
const compressible = /** @type {() => typeof import("compressible")} */ (lazyRequire("compressible"));
const {
    NullObject,
    asStatError,
    bindContext,
    durationSetting,
    httpError,
    memoizeByString,
    containsDotFile,
    UP_PATH_REGEXP,
    negotiateEncoding,
    cachedStat,
    ENCODING_BR,
    ENCODING_GZIP
} = require("./utils.js");

/** @typedef {import("./request.js")} Request */
/** @typedef {import("./response.js")} Response */
/** @typedef {import("./utils.js").HttpError} HttpError */

// the twins express.static serves with preCompressed on, the suffixes nginx and every build
// tool agree on, ordered by what is worth having
const PRECOMPRESSED = [
    { encoding: "br", suffix: ".br", flag: ENCODING_BR },
    { encoding: "gzip", suffix: ".gz", flag: ENCODING_GZIP }
];

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
 * Whether a file of this extension may have a `.br` or `.gz` twin: a webp or a woff2 never does,
 * and looking cost two stats. An unknown extension is looked up, it might be text.
 *
 * @param {string} extension including the dot, or "" for a name without one
 * @returns {boolean}
 */
const hasTwins = memoizeByString((extension) => {
    const type = mime().lookup(extension);
    return type ? compressible()(type) === true : true;
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
 * A request express.static will not serve: next() under fallthrough, else the status and an error.
 *
 * @param {Response} res
 * @param {(err?: unknown) => void} next
 * @param {boolean|undefined} fallthrough
 * @param {number} status
 * @param {unknown} [fsError] handed on as serve-static hands the fs error, else a plain HttpError
 */
function refuse(res, next, fallthrough, status, fsError) {
    if (fallthrough) {
        return next();
    }
    res.status(status);
    return next(fsError === undefined ? httpError(status) : asStatError(/** @type {HttpError} */ (fsError)));
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
        twinTtl = cache === undefined ? 1000 : durationSetting(cache, "option preCompressed.cache");
    }
    options.root = root;
    const resolvedRoot = path.resolve(root);
    // serve-static never asks the app: a static file keeps its ETag under app.set("etag", false)
    options.etag = options.etag !== false;
    options._ownEtag = true;
    // checked below on the path asked for, as send does: an index name or extension added later is not
    options._ownDotfiles = true;

    // serve-static's name, which express's layer.name and a tracer's span carry
    return function serveStatic(req, res, next) {
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
            return refuse(res, next, options.fallthrough, 400);
        }
        // a decoded NUL is a 400 as in send: reaching fs it came back as node's error with the
        // absolute root path inside
        if (url.indexOf("\0") !== -1) {
            return refuse(res, next, options.fallthrough, 400);
        }
        // a ".." that climbs out is a 403 before the disk is asked, as in send, with "\" counted on posix too
        if (url.includes("..") && UP_PATH_REGEXP.test(path.normalize("." + path.sep + url))) {
            return refuse(res, next, options.fallthrough, 403);
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
            return refuse(res, next, options.fallthrough, 403);
        }

        // before the stat, as send judges the path before the disk: a hidden segment in a missing
        // path answers the dotfiles rule, not ENOENT. Normalised first, ".." is not a dotfile. Split on
        // the platform separator as send does: on posix "a\.b" is one name
        if (containsDotFile(fullpath.slice(resolvedRoot.length).split(path.sep))) {
            const refusal = options.dotfiles === "deny" ? 403 : options.dotfiles === "allow" ? 0 : 404;
            if (refusal !== 0 && !(options.dotfiles === "ignore_files" && !path.basename(url).startsWith("."))) {
                return refuse(res, next, options.fallthrough, refusal);
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
            // no extension on a directory; on the decoded url and only after ENOENT, as send does:
            // ENOTDIR or ENAMETOOLONG report the path asked, not the last extension (fuzz seed 3561875562)
            if (
                /** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT" &&
                ext === "" &&
                !url.endsWith("/") &&
                options.extensions
            ) {
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
                // the fs error itself with errno, code, syscall and path, as serve-static hands it
                return refuse(res, next, options.fallthrough, 404, statError);
            }
        }

        // a file asked for with a trailing slash is a 404, ENOTDIR to send; with an index
        // configured the directory branch below reports the missing index instead
        if (req.endsWithSlash && !stat.isDirectory() && indexList.length === 0) {
            return refuse(res, next, options.fallthrough, 404);
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
                    return refuse(res, next, options.fallthrough, 404);
                }
            }
            if (indexList.length > 0) {
                let found;
                try {
                    found = findIndexFile(fullpath, indexList);
                } catch (err) {
                    return refuse(res, next, options.fallthrough, 404, err);
                }
                if (found === null) {
                    // every name was a directory, send's plain 404
                    return refuse(res, next, options.fallthrough, 404);
                }
                stat = found.stat;
                _path = path.join(url, found.name);
                filePath = found.candidate;
            } else {
                // a directory with no index is a 404, which fallthrough: false has to say
                return refuse(res, next, options.fallthrough, 404);
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
                const type = mime().lookup(filePath);
                res.type(type || "application/octet-stream");
            }
        }

        options._stat = stat;
        // nothing added to the path asked for: sendFile takes this file instead of joining it again
        options._fullpath = _path === url ? filePath : undefined;

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

module.exports = serveStatic;
