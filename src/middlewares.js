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

const fs = require("fs");
const path = require("path");
const bytes = require("bytes");
const zlib = require("fast-zlib");
const typeis = require("type-is");
const querystring = require("fast-querystring");
const { AsyncResource } = require("async_hooks");
const { fastQueryParse, NullObject } = require("./utils.js");

// largest content-length we will allocate a body buffer for up front. above this the body is
// collected chunk by chunk instead, so a declared-but-unsent body cannot pin more memory than a
// real one of the same size would
const MAX_PREALLOCATED_BODY = 1024 * 1024;

// The status send picks for a failed stat. Anything else is the file being there but unreadable,
// which is the server's problem and not the request's.
const STAT_ERROR_STATUS = { ENAMETOOLONG: 404, ENOTDIR: 404, ENOENT: 404 };

/**
 * Marks an fs error the way send does before handing it to next(), so an error handler reading
 * err.status or err.statusCode finds what it would find behind Express. The three properties are
 * assigned in this order because they are serialised in insertion order, and an error handler that
 * answers with res.send(err) sends them.
 *
 * @param {any} err
 * @returns {any} the same error
 */
function asSendError(err) {
    err.expose = false;
    err.statusCode = STAT_ERROR_STATUS[err.code] ?? 500;
    err.status = err.statusCode;
    return err;
}

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
 * The error a body parser hands to next(), shaped the way body-parser shapes it.
 *
 * This matters more than it looks. The error handler almost every Express application has is
 * `res.status(err.status || 500)`, so an error without a status answers 500 to a request that was
 * simply too large or badly formed. The client cannot tell a bad request from a broken server, and
 * whatever counts 5xx counts it against the server.
 *
 * `type` is part of the contract too: body-parser sets it to entity.too.large, entity.parse.failed
 * and so on, and applications branch on it.
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
 * express.static, which is a thin front for res.sendFile: it resolves the path, refuses anything
 * that climbs out of the root, applies the dotfiles and index rules, and hands the rest over.
 *
 * @param {string} root directory to serve from
 * @param {object} [options] index, redirect, fallthrough, dotfiles, extensions, setHeaders, etag
 * @returns {(req: any, res: any, next: (err?: any) => void) => any}
 */
function serveStatic(root, options) {
    if (!options) options = new NullObject();
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
    options.root = root;
    // serve-static decides this for itself and never asks the app, so a static file keeps its
    // ETag under app.set("etag", false) and only { etag: false } here turns it off. res.sendFile
    // takes the app's setting instead, which is why this has to be said out loud.
    options.etag = options.etag !== false;
    options._ownEtag = true;

    return (req, res, next) => {
        const iq = req.url.indexOf("?");
        let url;

        next = AsyncResource.bind(next);

        try {
            url = decodeURIComponent(iq !== -1 ? req.url.substring(0, iq) : req.url);
        } catch (e) {
            if (!options.fallthrough) {
                res.status(404);
                return next(new Error("Not found"));
            } else return next();
        }
        let _path = url;
        const fullpath = path.resolve(path.join(options.root, url));
        if (options.root && !fullpath.startsWith(path.resolve(options.root))) {
            if (!options.fallthrough) {
                res.status(403);
                return next(new Error("Forbidden"));
            } else return next();
        }

        let stat;
        try {
            stat = fs.statSync(fullpath);
        } catch (err) {
            const ext = path.extname(fullpath);
            let i = 0;
            if (ext === "" && options.extensions) {
                while (i < options.extensions.length) {
                    try {
                        stat = fs.statSync(fullpath + "." + options.extensions[i]);
                        _path = url + "." + options.extensions[i];
                        break;
                    } catch (err) {
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
                    return next(asSendError(err));
                } else return next();
            }
        }

        if (stat.isDirectory()) {
            if (!req.endsWithSlash) {
                if (options.redirect) {
                    // The query goes along, and the leading slashes are collapsed. Both were
                    // wrong: "/docs?page=3" redirected to "/docs/" and lost the page, and a
                    // request for "//assets" answered "Location: //assets/", which a browser
                    // reads as a protocol-relative URL and follows to the host "assets". A
                    // redirect that leaves this server is not a redirect this server meant.
                    return res.redirect(301, collapseLeadingSlashes(req._originalPath + "/") + req.urlQuery, true);
                } else {
                    if (!options.fallthrough) {
                        res.status(404);
                        return next(new Error("Not found"));
                    } else return next();
                }
            }
            if (options.index) {
                try {
                    stat = fs.statSync(path.join(fullpath, options.index));
                    _path = path.join(url, options.index);
                } catch (err) {
                    if (!options.fallthrough) {
                        res.status(404);
                        return next(new Error("Not found"));
                    } else return next();
                }
            } else {
                return next();
            }
        }

        options._stat = stat;

        return res.sendFile(_path, options, (e) => {
            if (e) {
                next(!options.fallthrough ? e : undefined);
            }
        });
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
    switch (encoding) {
        case "identity":
            return;
        case "deflate":
            return new zlib.Inflate();
        case "gzip":
            return new zlib.Gunzip();
        case "br":
            return new zlib.BrotliDecompress();
        default:
            return false;
    }
}

/**
 * Builds one of the body parsers. All four share the same work, which is deciding whether this
 * request has a body worth reading, collecting it within the size limit, decompressing it and
 * handing the bytes over; they differ only in the content type they claim by default and in what
 * they turn the bytes into.
 *
 * @param {string} defaultType the type matched when the caller names none
 * @param {(...args: any[]) => any} beforeReturn turns the collected bytes into req.body. Called
 *   with the body, the request, the response, next and the options
 * @returns {(options?: object) => Function} the middleware factory
 */
function createBodyParser(defaultType, beforeReturn) {
    return function (options) {
        if (typeof options !== "object") {
            options = new NullObject();
        }
        if (typeof options.limit === "undefined") options.limit = bytes("100kb");
        else options.limit = bytes(options.limit);

        if (typeof options.inflate === "undefined") options.inflate = true;
        if (typeof options.type === "undefined") options.type = defaultType;
        if (typeof options.type === "string") {
            if (!options.type.includes("*")) {
                options.simpleType = options.type;
            }
            options.type = [options.type];
        } else if (typeof options.type !== "function" && !Array.isArray(options.type)) {
            throw new Error("type must be a string, function or an array");
        }
        if (typeof options.defaultCharset === "undefined") options.defaultCharset = "utf-8";

        let additionalMethods;

        return (req, res, next) => {
            next = AsyncResource.bind(next);

            // skip reading body twice
            if (req.bodyRead) {
                return next();
            }

            const type = req.headers["content-type"];

            // req.body is deliberately left undefined until a parser claims the request. That is
            // what lets a handler tell "nothing parsed this" apart from "the body was empty",
            // so it must not be seeded with an empty object first.

            // skip reading body for no content type
            if (!type) {
                return next();
            }

            const length = req.headers["content-length"];

            // No content-length and no transfer-encoding means the request carries no body at all,
            // and a body parser must leave it alone rather than parse nothing into an empty value.
            // type-is applies this before matching the type, but the simpleType shortcut below
            // compares strings directly and would otherwise skip the check.
            if (req.headers["transfer-encoding"] === undefined && isNaN(length)) {
                return next();
            }

            if (options.simpleType) {
                const semicolonIndex = type.indexOf(";");
                const clearType = semicolonIndex !== -1 ? type.substring(0, semicolonIndex) : type;
                if (clearType !== options.simpleType) {
                    return next();
                }
            } else {
                if (typeof options.type === "function") {
                    if (!options.type(req)) {
                        return next();
                    }
                } else {
                    if (!typeis(req, options.type)) {
                        return next();
                    }
                }
            }

            // an empty body still has to produce this parser's empty value the way express does -
            // {} for json and urlencoded, '' for text, an empty Buffer for raw - rather than leaving
            // req.body as the placeholder object. there is nothing to read, so run the tail directly
            if (length == "0") {
                return beforeReturn(req, res, next, options, Buffer.alloc(0));
            }

            // skip reading too large body
            if (length && +length > options.limit) {
                return next(
                    bodyError("request entity too large", 413, "entity.too.large", {
                        expected: +length,
                        length: +length,
                        limit: options.limit
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
            if (options.inflate) {
                inflate = createInflate(req.headers["content-encoding"]);
                if (inflate === false) {
                    return next(
                        bodyError(
                            'unsupported content encoding "' + req.headers["content-encoding"] + '"',
                            415,
                            "encoding.unsupported",
                            { encoding: req.headers["content-encoding"] }
                        )
                    );
                }
            }

            // uWS neuters its ArrayBuffer after the callback, so every chunk has to be copied out of
            // it - and then Buffer.concat copied the whole body a second time. when content-length is
            // known and we aren't inflating, the final size is known up front, so chunks can go
            // straight into one buffer and the body is copied once.
            // the cap means a client that declares a body and never sends it costs no more than one
            // that actually sends a body that size, and content-length above options.limit was
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
                    buf = inflate.process(buf);
                }

                totalSize += buf.length;
                if (totalSize > options.limit) {
                    finished = true;
                    abs.length = 0;
                    target = null;
                    return next(
                        bodyError("request entity too large", 413, "entity.too.large", {
                            limit: options.limit,
                            received: totalSize
                        })
                    );
                }

                if (target) {
                    if (targetOffset + buf.length <= target.length) {
                        buf.copy(target, targetOffset);
                        targetOffset += buf.length;
                        return;
                    }
                    // more body than content-length promised: keep what we have and fall back
                    abs.push(Buffer.from(target.subarray(0, targetOffset)));
                    target = null;
                }

                // shallow copy, to avoid shared references for large bodies.
                abs.push(Buffer.from(buf));
            }

            /** The body is complete: assemble it, hand it to the parser and continue routing. */
            function onEnd() {
                if (finished) {
                    return;
                }
                finished = true;
                // target holds the whole body already; otherwise a single chunk is the body, and
                // only a genuinely chunked body needs the concat
                const buf = target
                    ? targetOffset === target.length
                        ? target
                        : target.subarray(0, targetOffset)
                    : abs.length === 1
                      ? abs[0]
                      : Buffer.concat(abs);
                if (options.verify) {
                    try {
                        options.verify(req, res, buf);
                    } catch (e) {
                        const err = /** @type {any} */ (e);
                        return next(
                            bodyError(
                                err.message,
                                err.status ?? err.statusCode ?? 403,
                                err.type ?? "entity.verify.failed",
                                {
                                    body: buf,
                                    stack: err.stack
                                }
                            )
                        );
                    }
                }
                beforeReturn(req, res, next, options, buf);
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
    };
}

const json = createBodyParser("application/json", function (req, res, next, options, buf) {
    if (buf.length === 0) {
        req.body = {};
        return next();
    }
    // A leading byte order mark is removed rather than parsed. body-parser never sees one either:
    // it decodes through iconv, which strips it, so by the time the first character is looked at
    // the mark is gone. JSON.parse would refuse it, so without this a body saved by an editor that
    // writes a BOM is answered 400 here and 200 by Express.
    const text = stripBom(buf.toString());

    // "strict" means only an object or an array is a body, which is body-parser's default and was
    // not honoured here at all: the check read req.body before this function had parsed anything,
    // so it looked at the previous request's body and passed. `express.json()` accepted a bare
    // string or number where Express answers 400.
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
        // the JSON error's own message, which is what body-parser keeps, so an application showing
        // err.message still says where the parse gave up
        const err = /** @type {any} */ (e);
        return next(bodyError(err.message, 400, "entity.parse.failed", { body: text }));
    }

    next();
});

const raw = createBodyParser("application/octet-stream", function (req, res, next, options, buf) {
    req.body = buf;
    next();
});

const text = createBodyParser("text/plain", function (req, res, next, options, buf) {
    const contentType = req.headers["content-type"];
    const charsetIndex = contentType.indexOf("charset=");
    let encoding = options.defaultCharset;
    if (charsetIndex !== -1) {
        encoding = contentType.substring(charsetIndex + 8);
        const semicolonIndex = encoding.indexOf(";");
        if (semicolonIndex !== -1) {
            encoding = encoding.substring(0, semicolonIndex);
        }
        encoding = encoding.trim().toLowerCase();
    }
    if (encoding !== "utf-8" && encoding !== "utf-16le" && encoding !== "latin1") {
        return next(
            bodyError('unsupported charset "' + encoding.toUpperCase() + '"', 415, "charset.unsupported", {
                charset: encoding.toLowerCase()
            })
        );
    }
    try {
        req.body = buf.toString(encoding);
    } catch (e) {
        return next(e);
    }

    next();
});

const urlencoded = createBodyParser("application/x-www-form-urlencoded", function (req, res, next, options, buf) {
    try {
        // Express 5 defaults extended to false, so nested keys need opting in
        const extended = typeof options.extended !== "undefined" ? options.extended : false;
        if (extended) {
            req.body = fastQueryParse(buf.toString(), options);
        } else {
            req.body = querystring.parse(buf.toString());
        }
    } catch (e) {
        return next(e);
    }
    next();
});

module.exports = {
    static: serveStatic,
    json,
    raw,
    text,
    urlencoded
};
