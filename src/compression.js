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

// express.compression(), which answers with a compressed body when the client asked for one.
//
// The options, the defaults and the order the decision is taken in are the compression module's,
// so a front that already uses it can drop the require and change nothing else. Two things are
// different, and both only ever turn a worse answer into a better one:
//
//   - a response that arrives whole, which is every res.send() and res.json(), is compressed in
//     one call instead of through a transform stream, and goes out with a Content-Length. The
//     bytes are the same bytes: zlib.gzipSync and a createGzip that receives the same body in one
//     write produce the same deflate output.
//   - partial content is left alone. The compression module compresses a 206 as well, and the
//     result is a byte range of the file described as gzip, which no client can decode.
//
// The streaming half is the module's own design, because it is the right one: a transform stream,
// its output written as it comes, and the drain listeners moved onto it so a pipe that fills up
// hears from the compressor rather than from a socket that is no longer what it is waiting for.

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
    memoizeByString
} = require("./utils.js");

// what the `encodings` option may name, and the mask each name contributes. identity is 0: an
// uncompressed answer is always on offer, naming it only makes the list read complete
const ENCODING_MASKS = new Map([
    ["br", ENCODING_BR],
    ["gzip", ENCODING_GZIP],
    ["deflate", ENCODING_DEFLATE],
    ["identity", 0]
]);

// Cache-Control: no-transform forbids recoding the body, which is what this does
const NO_TRANSFORM = /(?:^|,)\s*?no-transform\s*?(?:,|$)/;

/**
 * Says the answer depends on Accept-Encoding. res.vary() parses what is there and merges, which on
 * the usual response is parsing an absent header: only a response that already varies pays for it.
 *
 * @param {any} res
 */
function addVary(res) {
    if (res.getHeader("Vary") === undefined) {
        res.setHeader("Vary", "Accept-Encoding");
        return;
    }
    res.vary("Accept-Encoding");
}

/**
 * res.flush for a response that is not being compressed. The compression module puts a function
 * there on every response it sees, and code written against it calls one without asking first.
 */
function noFlush() {}

// what enforceEncoding is allowed to name, the compression module's list
const ENFORCEABLE = new Set(["gzip", "deflate", "identity", "br"]);

// Up to this many bytes a whole body is compressed on this thread, and above it on the libuv pool.
// One call either way; what changes is who waits. A small body pays more for the hop onto the pool
// than the compression costs, and a large one is worth handing over, since the pool has four
// threads and the loop has everyone else to serve: measured with gzip at the default level, sync
// wins by 43% at 1.4KB and by 22% at 16KB, and loses by 32% at 32KB and by 90% at 78KB.
const SYNC_LIMIT = 24 * 1024;

/**
 * The default filter: whether the content type is worth compressing at all. A response with no
 * type is left alone, since nothing says what its bytes are.
 *
 * @param {any} req
 * @param {any} res
 * @returns {boolean}
 */
function shouldCompress(req, res) {
    const type = res.getHeader("Content-Type");
    if (type === undefined) {
        return false;
    }
    // memoized, because an application answers with two or three content-types and compressible
    // splits the parameters off and searches the mime database to reach the same answer each time
    return isCompressible(typeof type === "string" ? type : String(type));
}

const isCompressible = memoizeByString((type) => compressible(type) === true);

/**
 * How many bytes a chunk is, which is what the threshold is compared against.
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
 * The bytes of a chunk, whatever it arrived as.
 *
 * @param {any} chunk
 * @param {BufferEncoding} [encoding]
 * @returns {Buffer}
 */
function toBuffer(chunk, encoding) {
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }
    // end() with nothing to send still has to hand the compressor something, and a threshold of 0
    // lets an empty body reach it: Buffer.from(undefined) throws where this sends the empty answer
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
 * @param {(req: any, res: any) => boolean} [options.filter] whether this response should be
 *   compressed at all. The default says yes to any compressible content type.
 * @param {string} [options.enforceEncoding] what to use when the request carries no
 *   Accept-Encoding at all. Default "identity", which is to say nothing is compressed.
 * @param {object} [options.brotli] brotli options, `params` included. The default quality is 4.
 * @param {string[]} [options.encodings] the encodings this middleware may answer with, out of
 *   "br", "gzip" and "deflate". What is not named is never used, however the client ranks it: a
 *   server that prefers cheap gzip over brotli passes ["gzip", "deflate"]. An uncompressed answer
 *   is always on offer, and enforceEncoding stays its own explicit choice, outside this list.
 *   This option is fulmine's own, the compression module has no equivalent.
 * @param {number} [options.level] zlib compression level, for gzip and deflate.
 * @param {number} [options.chunkSize] zlib chunk size.
 * @param {number} [options.memLevel] zlib memory level.
 * @param {number} [options.strategy] zlib strategy.
 * @param {number} [options.windowBits] zlib window size.
 * @returns {(req: any, res: any, next: (err?: any) => void) => void} the middleware
 */
function compression(options) {
    const opts = options || {};
    // the whole bag goes to zlib, as the compression module does: level, memLevel, strategy,
    // windowBits and chunkSize arrive under their own names and zlib ignores the rest
    const zlibOptions = /** @type {any} */ (opts);
    const brotliOptions = { ...opts.brotli };
    brotliOptions.params = {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
        ...(opts.brotli && /** @type {any} */ (opts.brotli).params)
    };
    const filter = opts.filter || shouldCompress;
    const enforceEncoding = opts.enforceEncoding || "identity";
    // bytes.parse reads "1kb" and hands back null for anything it cannot, an absent option
    // included, which is where the default comes in
    const threshold = bytes.parse(/** @type {any} */ (opts.threshold)) ?? 1024;
    // the mask handed to the negotiation, built once here: a name nobody knows is a config
    // mistake and throws now rather than serving the wrong bytes later
    let allowed = ENCODING_ANY;
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
            allowed |= mask;
        }
    }

    /**
     * A whole body, compressed on this thread. Blocks the event loop for as long as it takes,
     * which is why only a small one comes here, see SYNC_LIMIT.
     *
     * @param {string} method
     * @param {Buffer} body
     * @returns {Buffer}
     */
    function compressWhole(method, body) {
        if (method === "gzip") {
            return zlib.gzipSync(body, zlibOptions);
        }
        if (method === "br") {
            return zlib.brotliCompressSync(body, brotliOptions);
        }
        return zlib.deflateSync(body, zlibOptions);
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
        } else {
            zlib.deflate(body, zlibOptions, done);
        }
    }

    /**
     * @param {string} method
     * @returns {any} the transform stream for a body that arrives in pieces
     */
    function compressStream(method) {
        if (method === "gzip") {
            return zlib.createGzip(zlibOptions);
        }
        if (method === "br") {
            return zlib.createBrotliCompress(brotliOptions);
        }
        return zlib.createDeflate(zlibOptions);
    }

    return function compression(req, res, next) {
        // Negotiated here rather than when the body arrives, because the answer to "could this
        // request take a compressed body at all" decides how much of this middleware the response
        // has to carry. Most requests to most routes cannot: a client that sent no Accept-Encoding,
        // one that refused everything, a HEAD. Those get the Vary and nothing else, since the
        // answer still depends on the header even when this particular client did not ask.
        // straight from the raw entries where this request keeps them: reading req.headers here
        // built the whole object for one name. Folded, so a repeated Accept-Encoding still reads
        // as the joined list the headers object would have shown
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
            let varied = false;
            res.end = function end(chunk, encoding, callback) {
                if (!varied) {
                    varied = true;
                    const cacheControl = res.headersSent ? undefined : res.getHeader("Cache-Control");
                    if (
                        !res.headersSent &&
                        filter(req, res) &&
                        !(cacheControl && NO_TRANSFORM.test(String(cacheControl)))
                    ) {
                        addVary(res);
                    }
                }
                return _plainEnd.call(this, chunk, encoding, callback);
            };
            return next();
        }

        const _write = res.write;
        const _end = res.end;
        const _on = res.on;

        /** drain listeners parked until there is a compressor to hang them on, see res.on below */
        let listeners = /** @type {any[][]|null} */ ([]);
        /** @type {any} */
        let stream = null;
        let decided = false;
        let ended = false;
        /** what end() was given to call back, held until the compressor has finished */
        let endCallback = /** @type {any} */ (undefined);

        // the compression module adds this, and code written against it calls it: an SSE feed
        // pushes its event out with res.flush(). Nothing to flush before there is a compressor
        res.flush = function flush() {
            if (stream) {
                stream.flush();
            }
        };

        /**
         * Hands back the parked drain listeners: this response is not being compressed, so the
         * response itself is what a pipe should hear from.
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
         * Whether this response is compressed, and how. Taken once, when the first byte of the
         * body arrives, which is also when the headers are decided: everything read here is set
         * by then. The order is the compression module's, and so is the Vary, which is added even
         * when the answer goes out uncompressed because the answer still depends on the header.
         *
         * @param {number} [length] the size of the body, when end() already has all of it
         * @returns {string} the encoding chosen, "" to send the body as it is
         */
        function decide(length) {
            decided = true;
            // res.flushHeaders() commits the head here rather than holding it until the body, so a
            // response that used it has no room left for a Content-Encoding
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
            // NaN when there is no Content-Length, and a comparison against NaN is false: a body
            // whose size is not known yet is compressed whatever the threshold says
            if (Number(res.getHeader("Content-Length")) < threshold || Number(length) < threshold) {
                return noCompress();
            }
            const already = res.getHeader("Content-Encoding");
            if (already && already !== "identity") {
                return noCompress();
            }
            // a range is a window into the bytes on disk, and a client that asked for one cannot
            // decode a compressed answer to it
            if (res.statusCode === 206 || res.getHeader("Content-Range") !== undefined) {
                return noCompress();
            }
            // HEAD never reaches here: it took the Vary-only path above
            res.setHeader("Content-Encoding", chosen);
            // what it says is the size of the body before this middleware saw it. The whole-body
            // path below puts the right one back; the streaming one cannot know it in advance
            res.removeHeader("Content-Length");
            return chosen;
        }

        /**
         * Starts the compressor for a body that arrives in pieces, and wires it to the response.
         * @param {string} method
         */
        function startStream(method) {
            stream = compressStream(method);
            // The parked listeners, and the list itself stays rather than being emptied: res.on
            // reads it to know that a drain listener belongs on the compressor from here on. That
            // matters because a pipe registers its own the first time write() tells it to slow
            // down, which is after this, and from here on the compressor is what fills up.
            for (const listener of /** @type {any[][]} */ (listeners)) {
                stream.on(listener[0], listener[1]);
            }
            stream.on("data", (chunk) => {
                if (_write.call(res, chunk) === false) {
                    stream.pause();
                }
            });
            stream.on("end", () => {
                _end.call(res, endCallback);
            });
            _on.call(res, "drain", () => stream.resume());
            // an aborted response never reaches the end of the stream, and the zlib context behind
            // it is native memory that a garbage collector is in no hurry to reach
            _on.call(res, "close", () => stream.destroy());
        }

        res.write = function write(chunk, encoding, callback) {
            if (typeof encoding === "function") {
                callback = encoding;
                encoding = undefined;
            }
            if (ended) {
                return false;
            }
            if (!decided) {
                const method = decide();
                if (method) {
                    startStream(method);
                }
            }
            if (stream) {
                return stream.write(toBuffer(chunk, encoding), callback);
            }
            return _write.call(this, chunk, encoding, callback);
        };

        res.end = function end(chunk, encoding, callback) {
            // node's shapes, of which this project's own end() takes (data, cb): the third
            // argument only arrives from code written against node's ServerResponse
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
            if (!decided) {
                const method = decide(chunkLength(chunk, encoding));
                if (method) {
                    // the whole answer is here, so it is compressed in one call rather than
                    // through a stream, and goes out with the length it ended up being
                    ended = true;
                    const input = toBuffer(chunk, encoding);
                    if (input.length <= SYNC_LIMIT) {
                        const body = compressWhole(method, input);
                        res.setHeader("Content-Length", String(body.length));
                        return _end.call(this, body, callback);
                    }
                    compressWholeAsync(method, input, (err, body) => {
                        // the client can leave while the pool is working, and writing to a
                        // response that is already gone is not something uWS survives
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
            // there is nothing to listen to yet: a compressor that does not exist has not filled up
            listeners.push([type, listener]);
            return this;
        };

        next();
    };
}

module.exports = compression;
// the compression module exports its default filter, and a front that wants to compress one more
// type than the default calls it and adds to what it says
module.exports.filter = shouldCompress;
