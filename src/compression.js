/*
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

/** @typedef {import("./request.js")} Request */
/** @typedef {import("./response.js")} Response */
/**
 * What res.on was given, parked until there is a compressor to hang it on.
 * @typedef {Parameters<import("stream").Writable["on"]>} OnArgs
 */

// express.compression(): the compression module's options, defaults and decision order, with three
// differences: a whole body (res.send, res.json) is compressed in one call and goes out with a
// Content-Length, a 206 is left alone (a compressed byte range decodes nowhere), and zstd is on
// offer, ranked between brotli and gzip. The streaming half is the module's own transform design.

"use strict";

const zlib = require("zlib");
const bytes = require("bytes");
const compressible = require("compressible");
const {
    negotiateEncoding,
    ENCODING_ANY,
    ENCODING_BR,
    ENCODING_GZIP,
    ENCODING_DEFLATE,
    ENCODING_ZSTD,
    memoizeByString,
    applyWriteHead
} = require("./utils.js");

// zstd arrived in node's zlib inside the range of versions this supports
const HAS_ZSTD = typeof zlib.zstdCompressSync === "function";

// what the `encodings` option may name; identity is 0, an uncompressed answer is always on offer
const ENCODING_MASKS = new Map([
    ["br", ENCODING_BR],
    ["zstd", ENCODING_ZSTD],
    ["gzip", ENCODING_GZIP],
    ["deflate", ENCODING_DEFLATE],
    ["identity", 0]
]);

const ENCODING_DEFAULT = HAS_ZSTD ? ENCODING_ANY : ENCODING_ANY & ~ENCODING_ZSTD;

// Cache-Control: no-transform forbids recoding the body
const NO_TRANSFORM = /(?:^|,)\s*?no-transform\s*?(?:,|$)/;

/**
 * Vary: Accept-Encoding, through res.vary() only when there is a Vary to merge into.
 *
 * @param {Response} res
 */
function addVary(res) {
    if (res.getHeader("Vary") === undefined) {
        res.setHeader("Vary", "Accept-Encoding");
        return;
    }
    res.vary("Accept-Encoding");
}

/** res.flush for a response not being compressed: the compression module puts one on every response. */
function noFlush() {}

// what enforceEncoding may name
const ENFORCEABLE = new Set(["gzip", "deflate", "identity", "br"]);
if (HAS_ZSTD) {
    ENFORCEABLE.add("zstd");
}

// up to this many bytes a whole body is compressed on this thread, above on the libuv pool: gzip
// sync wins by 43% at 1.4KB and 22% at 16KB, loses by 32% at 32KB and 90% at 78KB
const SYNC_LIMIT = 24 * 1024;

const noop = () => {};

/**
 * A whole-body compressor on one reused zlib stream: building one per call costs more than the
 * compression under the sync limit, this is the same bytes in a third of the time. It holds
 * node's private close and handle in place across FINISH, and a probe falls back to `oneShot` on
 * a node that behaves differently. Deflate formats only, a brotli stream keeps context on reset.
 *
 * @param {() => any} create makes the stream. Loose because what is checked below is node's zlib
 *   internals, which its typings do not declare
 * @param {number} finishFlag
 * @param {(body: Buffer) => Buffer} oneShot
 * @returns {(body: Buffer) => Buffer}
 */
function reusableCompressor(create, finishFlag, oneShot) {
    let stream;
    try {
        stream = create();
    } catch {
        return oneShot;
    }
    const handle = stream._handle;
    if (
        typeof stream._processChunk !== "function" ||
        typeof stream.reset !== "function" ||
        !handle ||
        typeof handle.close !== "function"
    ) {
        return oneShot;
    }
    const realClose = stream.close;
    const realHandleClose = handle.close;
    let broken = false;
    // a second body can only arrive from inside the first one, and goes the ordinary way
    let busy = false;

    // an abandoned half-finished zlib handle emits an uncaught "buffer error" later
    const giveUp = () => {
        broken = true;
        try {
            stream.on("error", noop);
            stream.destroy();
        } catch {
            // on its way out either way
        }
        return oneShot;
    };

    /** @param {Buffer} body */
    const compress = (body) => {
        if (broken || busy) {
            return oneShot(body);
        }
        busy = true;
        stream.close = noop;
        handle.close = noop;
        try {
            // FINISH drops the handle off the stream, put back below, then reset
            const out = Buffer.from(stream._processChunk(body, finishFlag));
            stream._handle = handle;
            stream.reset();
            return out;
        } catch {
            stream._handle = handle;
            giveUp();
            return oneShot(body);
        } finally {
            stream.close = realClose;
            handle.close = realHandleClose;
            stream.removeAllListeners("error");
            busy = false;
        }
    };

    // twice per probe: a stream that keeps state answers the second body differently
    for (const probe of [Buffer.alloc(64, 0x61), Buffer.from("{}".repeat(600))]) {
        const expected = oneShot(probe);
        if (!compress(probe).equals(expected) || !compress(probe).equals(expected)) {
            return giveUp();
        }
    }
    return compress;
}

/**
 * The default filter: whether the content type is compressible. No type, no compression.
 *
 * @param {Request} req
 * @param {Response} res
 * @returns {boolean}
 */
function shouldCompress(req, res) {
    const type = res.getHeader("Content-Type");
    if (type === undefined) {
        return false;
    }
    // memoised: compressible searches the mime database each time
    return isCompressible(typeof type === "string" ? type : String(type));
}

const isCompressible = memoizeByString((type) => compressible(type) === true);

/**
 * How many bytes a chunk is, for the threshold.
 *
 * @param {any} chunk
 * @param {BufferEncoding} [encoding]
 * @returns {number}
 */
function chunkLength(chunk, encoding) {
    if (chunk === undefined || chunk === null) {
        return 0;
    }
    return Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
}

/**
 * The bytes of a chunk.
 *
 * @param {any} chunk
 * @param {BufferEncoding} [encoding]
 * @returns {Buffer}
 */
function toBuffer(chunk, encoding) {
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }
    // an empty end() under a threshold of 0 still hands the compressor something
    if (chunk === undefined || chunk === null) {
        return Buffer.alloc(0);
    }
    return Buffer.from(chunk, encoding);
}

/**
 * Compresses a response body as the client asked for it.
 *
 * @param {object} [options]
 * @param {number|string} [options.threshold] the smallest body worth compressing, bytes or "1kb".
 *   Default 1024. A response whose size is not known in advance is compressed whatever its size.
 * @param {(req: Request, res: Response) => boolean} [options.filter] whether this response should be
 *   compressed at all. The default says yes to any compressible content type.
 * @param {string} [options.enforceEncoding] what to use when the request carries no
 *   Accept-Encoding at all. Default "identity", which is to say nothing is compressed.
 * @param {object} [options.brotli] brotli options, `params` included. The default quality is 4.
 * @param {object} [options.zstd] zstd options, `params` included, node's own defaults otherwise.
 * @param {string[]} [options.encodings] the encodings this middleware may answer with, out of
 *   "br", "zstd", "gzip" and "deflate". What is not named is never used, however the client ranks
 *   it. An uncompressed answer is always on offer, and enforceEncoding is outside this list. This
 *   option is fulmine's own, the compression module has no equivalent.
 * @param {number} [options.level] zlib compression level, for gzip and deflate.
 * @param {number} [options.chunkSize] zlib chunk size.
 * @param {number} [options.memLevel] zlib memory level.
 * @param {number} [options.strategy] zlib strategy.
 * @param {number} [options.windowBits] zlib window size.
 * @returns {(req: any, res: any, next: (err?: unknown) => void) => void} the middleware. The pair is
 *   loose because this is written against node's end() and write() shapes, which this project's
 *   own narrow
 */
function compression(options) {
    const opts = options || {};
    // the whole bag goes to zlib, as the compression module does
    const zlibOptions = /** @type {import("zlib").ZlibOptions} */ (opts);
    const brotliOptions = { ...opts.brotli };
    brotliOptions.params = {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
        ...(opts.brotli && /** @type {import("zlib").BrotliOptions} */ (opts.brotli).params)
    };
    // zstd at node's default level is already in the band this middleware wants
    const zstdOptions = { ...opts.zstd };
    const filter = opts.filter || shouldCompress;
    const enforceEncoding = opts.enforceEncoding || "identity";
    const threshold = bytes.parse(/** @type {string|number} */ (opts.threshold)) ?? 1024;
    // the mask for the negotiation, an unknown name throws here
    let allowed = ENCODING_DEFAULT;
    if (opts.encodings !== undefined) {
        if (!Array.isArray(opts.encodings)) {
            throw new TypeError("encodings must be an array of encoding names");
        }
        allowed = 0;
        for (const name of opts.encodings) {
            const mask = ENCODING_MASKS.get(name);
            if (mask === undefined) {
                throw new TypeError(`unknown encoding "${name}" in encodings`);
            }
            if (mask === ENCODING_ZSTD && !HAS_ZSTD) {
                throw new TypeError(`"zstd" needs a node whose zlib has zstd, and this one does not`);
            }
            allowed |= mask;
        }
    }

    // built on first use
    let gzipWhole;
    let deflateWhole;

    /**
     * A whole body compressed on this thread, only a small one, see SYNC_LIMIT.
     *
     * @param {string} method
     * @param {Buffer} body
     * @returns {Buffer}
     */
    function compressWhole(method, body) {
        if (method === "gzip") {
            gzipWhole ??= reusableCompressor(
                () => zlib.createGzip(zlibOptions),
                zlib.constants.Z_FINISH,
                (b) => zlib.gzipSync(b, zlibOptions)
            );
            return gzipWhole(body);
        }
        if (method === "br") {
            return zlib.brotliCompressSync(body, brotliOptions);
        }
        if (method === "zstd") {
            return zlib.zstdCompressSync(body, zstdOptions);
        }
        deflateWhole ??= reusableCompressor(
            () => zlib.createDeflate(zlibOptions),
            zlib.constants.Z_FINISH,
            (b) => zlib.deflateSync(b, zlibOptions)
        );
        return deflateWhole(body);
    }

    /**
     * The same, on the libuv thread pool.
     *
     * @param {string} method
     * @param {Buffer} body
     * @param {(err: Error|null, out: Buffer) => void} done
     */
    function compressWholeAsync(method, body, done) {
        if (method === "gzip") {
            zlib.gzip(body, zlibOptions, done);
        } else if (method === "br") {
            zlib.brotliCompress(body, brotliOptions, done);
        } else if (method === "zstd") {
            zlib.zstdCompress(body, zstdOptions, done);
        } else {
            zlib.deflate(body, zlibOptions, done);
        }
    }

    /**
     * @param {string} method
     * @returns {import("stream").Transform & import("zlib").Zlib} the transform stream for a body that
     *   arrives in pieces
     */
    function compressStream(method) {
        if (method === "gzip") {
            return zlib.createGzip(zlibOptions);
        }
        if (method === "br") {
            return zlib.createBrotliCompress(brotliOptions);
        }
        if (method === "zstd") {
            return zlib.createZstdCompress(zstdOptions);
        }
        return zlib.createDeflate(zlibOptions);
    }

    return function compression(req, res, next) {
        // negotiated now: a request that cannot take a compressed body, which is most, gets the
        // Vary and none of the wrapping below. Off the raw entries, req.headers built the object
        const accept =
            typeof req._foldedHeader === "function"
                ? req._foldedHeader("accept-encoding")
                : req.headers["accept-encoding"];
        let chosen = negotiateEncoding(accept === undefined ? "" : accept, allowed);
        if (accept === undefined && ENFORCEABLE.has(enforceEncoding)) {
            chosen = enforceEncoding;
        }
        if (!chosen || chosen === "identity" || req.method === "HEAD") {
            res.flush = noFlush;
            const _plainEnd = res.end;
            const _plainWriteHead = res.writeHead;
            let varied = false;
            /** Says the answer varies, once, before the head is settled. */
            const vary = () => {
                if (varied) {
                    return;
                }
                varied = true;
                const cacheControl = res.headersSent ? undefined : res.getHeader("Cache-Control");
                if (
                    !res.headersSent &&
                    filter(req, res) &&
                    !(cacheControl && NO_TRANSFORM.test(String(cacheControl)))
                ) {
                    addVary(res);
                }
            };
            // at writeHead too, its headers applied first as on-headers orders it
            res.writeHead = function writeHead(statusCode, statusMessage, headers) {
                const reason = applyWriteHead(this, statusMessage, headers);
                vary();
                return _plainWriteHead.call(this, statusCode, reason);
            };
            res.end = function end(chunk, encoding, callback) {
                vary();
                return _plainEnd.call(this, chunk, encoding, callback);
            };
            return next();
        }

        const _write = res.write;
        const _end = res.end;
        const _on = res.on;
        const _writeHead = res.writeHead;

        /** drain listeners parked until there is a compressor to hang them on, see res.on below */
        let listeners = /** @type {OnArgs[]|null} */ ([]);
        /** @type {(import("stream").Transform & import("zlib").Zlib)|null} */
        let stream = null;
        let decided = false;
        // "" for none; the compressor starts with the first byte
        let method = "";
        let ended = false;
        /** what end() was given to call back, held until the compressor has finished */
        let endCallback = /** @type {(() => void)|undefined} */ (undefined);

        // the compression module's, an SSE feed pushes its event out with it
        res.flush = function flush() {
            if (stream) {
                stream.flush();
            }
        };

        /**
         * Hands the parked drain listeners back to the response, which is not being compressed.
         * @returns {string} the empty method, so the callers can `return noCompress()`
         */
        function noCompress() {
            if (listeners) {
                for (const listener of listeners) {
                    _on.call(res, listener[0], listener[1]);
                }
                listeners = null;
            }
            return "";
        }

        /**
         * Whether this response is compressed and how, decided once at the first byte of body in
         * the compression module's order, Vary included.
         *
         * @param {number} [length] the size of the body, when end() already has all of it
         * @returns {string} the encoding chosen, "" to send the body as it is
         */
        function decide(length) {
            decided = true;
            // after res.flushHeaders() there is no room for a Content-Encoding
            if (res.headersSent) {
                return noCompress();
            }
            if (!filter(req, res)) {
                return noCompress();
            }
            const cacheControl = res.getHeader("Cache-Control");
            if (cacheControl && NO_TRANSFORM.test(String(cacheControl))) {
                return noCompress();
            }
            addVary(res);
            // NaN without a Content-Length, so an unknown size is compressed whatever the threshold
            if (Number(res.getHeader("Content-Length")) < threshold || Number(length) < threshold) {
                return noCompress();
            }
            const already = res.getHeader("Content-Encoding");
            if (already && already !== "identity") {
                return noCompress();
            }
            // a compressed byte range decodes nowhere
            if (res.statusCode === 206 || res.getHeader("Content-Range") !== undefined) {
                return noCompress();
            }
            res.setHeader("Content-Encoding", chosen);
            // the whole-body path puts the right one back
            res.removeHeader("Content-Length");
            return chosen;
        }

        /**
         * Starts the compressor for a body that arrives in pieces, and wires it to the response.
         * @param {string} method
         */
        function startStream(method) {
            const compressor = (stream = compressStream(method));
            // the parked listeners; the list stays, res.on reads it
            for (const listener of /** @type {OnArgs[]} */ (listeners)) {
                compressor.on(listener[0], listener[1]);
            }
            compressor.on("data", (chunk) => {
                if (_write.call(res, chunk) === false) {
                    compressor.pause();
                }
            });
            compressor.on("end", () => {
                _end.call(res, endCallback);
            });
            _on.call(res, "drain", () => compressor.resume());
            // an aborted response never ends the stream, and a zlib context is native memory
            _on.call(res, "close", () => compressor.destroy());
        }

        // decided at writeHead too, its headers applied first as on-headers orders it
        res.writeHead = function writeHead(statusCode, statusMessage, headers) {
            const reason = applyWriteHead(this, statusMessage, headers);
            if (!decided) {
                method = decide();
            }
            return _writeHead.call(this, statusCode, reason);
        };

        res.write = function write(chunk, encoding, callback) {
            if (typeof encoding === "function") {
                callback = encoding;
                encoding = undefined;
            }
            if (ended) {
                return false;
            }
            if (!decided) {
                method = decide();
            }
            if (method && !stream) {
                startStream(method);
            }
            if (stream) {
                return stream.write(toBuffer(chunk, encoding), callback);
            }
            return _write.call(this, chunk, encoding, callback);
        };

        res.end = function end(chunk, encoding, callback) {
            if (typeof chunk === "function") {
                callback = chunk;
                chunk = undefined;
                encoding = undefined;
            } else if (typeof encoding === "function") {
                callback = encoding;
                encoding = undefined;
            }
            if (ended) {
                return this;
            }
            if (!decided) {
                method = decide(chunkLength(chunk, encoding));
            }
            // after a writeHead the head cannot take a length any more, so the body streams
            if (method && !stream && res.headersSent) {
                startStream(method);
            }
            if (stream) {
                ended = true;
                endCallback = callback;
                if (chunk === undefined || chunk === null || chunk === "") {
                    stream.end();
                } else {
                    stream.end(toBuffer(chunk, encoding));
                }
                return this;
            }
            if (method) {
                // the whole answer is here, one call and a Content-Length
                ended = true;
                const input = toBuffer(chunk, encoding);
                if (input.length <= SYNC_LIMIT) {
                    const body = compressWhole(method, input);
                    res.setHeader("Content-Length", String(body.length));
                    return _end.call(this, body, callback);
                }
                compressWholeAsync(method, input, (err, body) => {
                    // the client can leave while the pool works
                    if (res.aborted || res.finished) {
                        return;
                    }
                    if (err) {
                        return res.destroy(err);
                    }
                    res.setHeader("Content-Length", String(body.length));
                    _end.call(res, body, callback);
                });
                return this;
            }
            ended = true;
            return _end.call(this, chunk, callback);
        };

        res.on = function on(type, listener) {
            if (!listeners || type !== "drain") {
                return _on.call(this, type, listener);
            }
            if (stream) {
                return stream.on(type, listener);
            }
            listeners.push([type, listener]);
            return this;
        };

        next();
    };
}

module.exports = compression;
// the compression module exports its default filter too
module.exports.filter = shouldCompress;
