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

// the global Buffer is a getter, a call on every read
const { Buffer } = require("buffer");
const bytes = require("bytes");
const { lazyRequire } = require("./lazy-require.js");
const zlib = /** @type {() => typeof import("fast-zlib")} */ (lazyRequire("fast-zlib"));
const typeis = /** @type {() => typeof import("type-is")} */ (lazyRequire("type-is"));
const qs = /** @type {() => typeof import("qs")} */ (lazyRequire("qs"));
const statuses = require("statuses");
const parseQuery = require("./parse-query.js");
const { kGetSafe } = require("./usage.js");

const { fastQueryParse, NullObject, bindContext, httpError, httpErrorName, memoizeByString } = require("./utils.js");

// the largest content-length a body buffer is allocated for up front, so a declared and never
// sent body cannot pin more memory than a real one
const MAX_PREALLOCATED_BODY = 1024 * 1024;

// what the finish pass feeds zlib: no bytes, only the flush flag
const EMPTY_BUFFER = Buffer.alloc(0);

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

// http-errors' shape, one class per status: status, statusCode and expose on its prototype, so a
// logger's JSON.stringify(err) or {...err} reads the same fields as with body-parser
/** @type {Map<number, new (message: string) => HttpError>} */
const httpErrorClasses = new Map();

/**
 * @param {number} status
 * @returns {new (message: string) => HttpError}
 */
function httpErrorClass(status) {
    let HttpErrorClass = httpErrorClasses.get(status);
    if (HttpErrorClass === undefined) {
        const name = httpErrorName(status);
        // named through a computed key, "PayloadTooLargeError", as http-errors names its classes
        HttpErrorClass = /** @type {any} */ ({ [name]: class extends Error {} })[name];
        const proto = /** @type {HttpError} */ (/** @type {any} */ (HttpErrorClass).prototype);
        proto.status = status;
        proto.statusCode = status;
        proto.expose = status < 500;
        httpErrorClasses.set(status, /** @type {any} */ (HttpErrorClass));
    }
    return /** @type {new (message: string) => HttpError} */ (HttpErrorClass);
}

/**
 * The error a body parser hands to next(), as body-parser shapes it through http-errors: the
 * message an own enumerable field, the name an own hidden one, then the extra fields and the type.
 *
 * @param {string} message
 * @param {number} status
 * @param {string} type body-parser's own name for the kind of failure
 * @param {object} [extra] anything else body-parser puts on that particular error
 * @returns {HttpError}
 */
function bodyError(message, status, type, extra) {
    const HttpErrorClass = httpErrorClass(status);
    const err = new HttpErrorClass(message);
    Object.defineProperty(err, "message", { configurable: true, enumerable: true, value: message, writable: true });
    Object.defineProperty(err, "name", {
        configurable: true,
        enumerable: false,
        value: HttpErrorClass.name,
        writable: true
    });
    Object.assign(err, extra);
    err.type = type;
    return err;
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

/** @type {{inflate?: Inflater|undefined, error?: HttpError}} nothing to inflate, shared */
const IDENTITY_ENCODING = Object.freeze({});

/**
 * What a Content-Encoding means: the decompressor to run, or the 415 it is refused with.
 *
 * @param {string|undefined} rawContentEncoding
 * @param {any} options the parser's options, read loosely: only inflate is looked at
 * @returns {{inflate?: Inflater|undefined, error?: HttpError}}
 */
function encodingFor(rawContentEncoding, options) {
    // nearly every body comes without one: no lowercase and no object per request
    if (rawContentEncoding === undefined) {
        return IDENTITY_ENCODING;
    }
    if (!options.inflate) {
        const contentEncoding = (rawContentEncoding || "identity").toLowerCase();
        if (contentEncoding !== "identity") {
            return {
                error: bodyError("content encoding unsupported", 415, "encoding.unsupported", {
                    encoding: contentEncoding
                })
            };
        }
        return IDENTITY_ENCODING;
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
            stream = new (zlib().Inflate)();
            break;
        case "gzip":
            stream = new (zlib().Gunzip)();
            break;
        case "br":
            stream = new (zlib().BrotliDecompress)();
            break;
        default:
            return false;
    }
    // the flag the final flush passes, so a truncated stream errors instead of resolving empty
    /** @type {Inflater} */ (stream)._finishFlag =
        encoding === "br" ? zlib().constants.BROTLI_OPERATION_FINISH : zlib().constants.Z_FINISH;
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
            (contentType) => !!typeis().is(contentType, /** @type {string[]} */ (options.type))
        );

        /** @type {string[]|null|undefined} the "body methods" setting, read on the first request */
        let additionalMethods;

        /**
         * The native collector owns only the state its callback uses. Keeping this callback and
         * the streaming functions out of the dispatcher avoids their context on skipped parsers
         * and keeps the streaming context out of the native collection path.
         *
         * @param {Request & {body?: unknown}} req
         * @param {Response} res
         * @param {(err?: unknown) => void} next already bound to the caller's async context
         * @param {string|undefined} encoding
         * @param {number} declared
         * @param {boolean} declaresLength
         */
        function collectNativeBody(req, res, next, encoding, declared, declaresLength) {
            req.bodyRead = true;
            // the body is this callback's, _settleBody has nothing to stream
            req._bodyClaimed = true;
            // the Readable never runs, and a later parser asks it
            req.complete = true;
            req.readable = false;
            req._res.collectBody(limit, (/** @type {ArrayBuffer|Buffer|null} */ body) => {
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
                // a Buffer is node:http's, through the shim, and Buffer.from() would copy it
                let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
                if (copyBody) {
                    buf = Buffer.from(buf);
                }
                if (!runVerify(req, res, next, options, buf, encoding)) {
                    return;
                }
                beforeReturn(req, res, next, options, buf, encoding);
            });
        }

        /**
         * The fallback collector: its per-request functions and buffering state are only needed
         * for decompression, a request already being read, or a transport without collectBody.
         *
         * @param {Request & {body?: unknown}} req
         * @param {Response} res
         * @param {(err?: unknown) => void} next already bound to the caller's async context
         * @param {string|undefined} encoding
         * @param {Inflater|undefined} inflate
         * @param {number} lengthNumber
         * @param {string|undefined} length the original header, preserving its conversion order
         */
        function collectStreamedBody(req, res, next, encoding, inflate, lengthNumber, length) {
            let totalSize = 0;

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
                // the body is this handler's, _settleBody must not replace it with the stream
                req._bodyClaimed = true;
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
        }

        // body-parser's name, which express's layer.name and a tracer's span carry. Given through
        // the key it is created under: defineProperty on the name put the function in dictionary mode
        const name = PARSER_NAMES[defaultType];
        /** @type {((req: Request & {body?: unknown}, res: Response, next: (err?: unknown) => void) => void) & {[kGetSafe]?: true}} */
        const parserMiddleware = {
            /**
             * @param {Request & {body?: unknown}} req
             * @param {Response} res
             * @param {(err?: unknown) => void} next
             */
            [name]: (req, res, next) => {
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

                // uWS delivers the body on native callbacks with no async context
                next = bindContext(next);

                // with nothing to decompress uWS collects the whole body natively: one callback, the
                // limit enforced before any byte reaches JS, no copy
                const declared = lengthNumber;
                const declaresLength = !Number.isNaN(declared) && declared > 0;
                // The pinned build declares collectBody, but older transports can lack it.
                if (
                    !req.receivedData &&
                    !inflate &&
                    /** @type {Partial<typeof req._res>} */ (req._res).collectBody &&
                    (declaresLength || isNaN(declared))
                ) {
                    collectNativeBody(req, res, next, encoding, declared, declaresLength);
                    return;
                }

                collectStreamedBody(req, res, next, encoding, inflate, lengthNumber, length);
            }
        }[name];
        // a request declaring no body leaves through the synchronous exit before any header is
        // read, so the header-skip analysis may trust it; a type function sees the request
        if (typeof options.type !== "function") {
            parserMiddleware[kGetSafe] = true;
        }
        return parserMiddleware;
    };
}

/** @type {Record<string, string>} */
const PARSER_NAMES = {
    "application/json": "jsonParser",
    "application/octet-stream": "rawParser",
    "text/plain": "textParser",
    "application/x-www-form-urlencoded": "urlencodedParser"
};

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
            // the four characters body-parser skips, space, tab, LF and CR, with a loop: the regex
            // allocated a match array per body, 56ns to 14
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
        // outside the try: body-parser puts the body on the errors below
        let body = "";
        try {
            body = decodeBody(buf, /** @type {string} */ (encoding));
            // Express 5 defaults extended to false
            const extended = typeof options.extended !== "undefined" ? options.extended : false;
            // qs alone knows a charset other than utf-8 and the sentinel options
            const needsQs = encoding !== "utf-8" || options.charsetSentinel || options.interpretNumericEntities;
            if (!extended && !needsQs) {
                // the vendored parser, the limit enforced inside its scan
                const parsed = parseQuery(body, undefined, options.parameterLimit, true);
                if (parseQuery.overflow === true) {
                    return next(Object.assign(bodyError("too many parameters", 413, "parameters.too.many"), { body }));
                }
                req.body = parsed;
            } else {
                const count = parameterCount(body, /** @type {number} */ (options.parameterLimit));
                if (count === undefined) {
                    return next(Object.assign(bodyError("too many parameters", 413, "parameters.too.many"), { body }));
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
                        ? Object.assign(Object.create(null), qs().parse(body, qsOptions))
                        : fastQueryParse(body, qsOptions);
                } else {
                    // body-parser's extended: false is still qs, depth 0
                    req.body = Object.assign(
                        Object.create(null),
                        qs().parse(body, {
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
                return next(
                    Object.assign(bodyError("The input exceeded the depth", 400, "querystring.parse.rangeError"), {
                        body
                    })
                );
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
    json,
    raw,
    text,
    urlencoded
};
