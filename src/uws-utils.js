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

"use strict";

// express.uwsUtils: the query, the body and the response of an app.uws() route, each one call away.
// Functions over µWS's own res and req and not a wrapper around them, so a route pays for what it
// calls and no object is built per request.

const { Buffer } = require("buffer");
const { pipeline } = require("stream");
const bytes = require("bytes");
const compression = require("./compression.js");
const parseQuery = require("./parse-query.js");
const { HEADER_NAME_BUF, HEADER_VALUE_BUF, statusLine, statusLineBytes } = require("./response-utils.js");
const { negotiateEncoding } = require("./utils.js");

/** @typedef {import("uWebSockets.js").HttpRequest} UwsRequest */
/** @typedef {import("uWebSockets.js").HttpResponse} UwsResponse */
/** @typedef {UwsResponse & {aborted?: boolean, _abortHook?: (() => void)|null}} GuardedResponse */
/** @typedef {{limit?: number|string}} ReadOptions */

// as express.text() and express.json()
const DEFAULT_LIMIT = 100 * 1024;

const TEXT_TYPE = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";
const OCTET_TYPE = "application/octet-stream";

// as bytes, see the same names in request.js and HEADER_NAME_BUF
const ACCEPT_ENCODING = Buffer.from("accept-encoding");
const CONTENT_TYPE = HEADER_NAME_BUF["content-type"];
const CONTENT_ENCODING = HEADER_NAME_BUF["content-encoding"];
const VARY = HEADER_NAME_BUF.vary;
const VARY_ACCEPT_ENCODING = HEADER_VALUE_BUF["Accept-Encoding"];

/**
 * The query string as req.query has it. Reads req, so before the handler returns.
 *
 * @param {UwsRequest} req
 * @returns {Record<string, string | string[]>}
 */
function query(req) {
    return parseQuery(req.getQuery());
}

/**
 * Registers the onAborted µWS wants before an answer written later, once per response, and keeps the
 * outcome on res.aborted, which send() reads. The read functions call it.
 *
 * @param {GuardedResponse} res
 * @returns {GuardedResponse}
 */
function guard(res) {
    if (res.aborted === undefined) {
        res.aborted = false;
        res.onAborted(() => {
            res.aborted = true;
            res._abortHook?.();
        });
    }
    return res;
}

/**
 * @param {ReadOptions} [options]
 * @returns {number}
 */
function limitOf(options) {
    const limit = options?.limit;
    if (limit === undefined) {
        return DEFAULT_LIMIT;
    }
    if (typeof limit === "number") {
        return limit;
    }
    const parsed = bytes.parse(limit);
    if (parsed === null) {
        throw new TypeError(`option limit "${String(limit)}" is invalid`);
    }
    return parsed;
}

/**
 * Answers with the status and its message.
 *
 * @param {GuardedResponse} res
 * @param {number} status
 */
function refuse(res, status) {
    send(res, status, null, statusLine(status, undefined).slice(4));
}

/**
 * The whole body, in one Buffer. A body that came in one piece is µWS's memory, not a copy: see
 * readBuffer. Over the limit it answers 413 and done is not called.
 *
 * @param {GuardedResponse} res
 * @param {number} limit
 * @param {(body: Buffer) => void} done
 */
function collect(res, limit, done) {
    guard(res);
    /** @type {Buffer[]|null} */
    let chunks = null;
    let length = 0;
    let finished = false;
    res.onData((chunk, isLast) => {
        if (finished || res.aborted) {
            return;
        }
        length += chunk.byteLength;
        if (length > limit) {
            finished = true;
            refuse(res, 413);
            return;
        }
        if (!isLast) {
            // µWS neuters the chunk when this returns
            (chunks ??= []).push(Buffer.from(new Uint8Array(chunk)));
            return;
        }
        finished = true;
        if (chunks === null) {
            done(Buffer.from(chunk));
            return;
        }
        chunks.push(Buffer.from(new Uint8Array(chunk)));
        done(Buffer.concat(chunks, length));
    });
}

/**
 * The body as a Buffer, content-length or chunked alike. As req, it is only good until callback
 * returns: µWS reuses the memory of a body that came in one piece, copy it to keep it.
 *
 * @param {UwsResponse} res
 * @param {(body: Buffer) => void} callback
 * @param {ReadOptions} [options] limit in bytes or as "1mb", 100kb by default
 */
function readBuffer(res, callback, options) {
    collect(res, limitOf(options), callback);
}

/**
 * The body as a utf-8 string.
 *
 * @param {UwsResponse} res
 * @param {(body: string) => void} callback
 * @param {ReadOptions} [options]
 */
function readText(res, callback, options) {
    collect(res, limitOf(options), (body) => callback(body.toString()));
}

/**
 * The body parsed as JSON, undefined when empty. Invalid JSON answers 400 and callback is not called.
 *
 * @param {UwsResponse} res
 * @param {(body: any) => void} callback
 * @param {ReadOptions} [options]
 */
function readJson(res, callback, options) {
    collect(res, limitOf(options), (body) => {
        if (body.length === 0) {
            callback(undefined);
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(body.toString());
        } catch {
            refuse(res, 400);
            return;
        }
        callback(parsed);
    });
}

/**
 * The body parsed as an urlencoded form, with the query string's rules.
 *
 * @param {UwsResponse} res
 * @param {(body: Record<string, string | string[]>) => void} callback
 * @param {ReadOptions} [options]
 */
function readForm(res, callback, options) {
    collect(res, limitOf(options), (body) => callback(parseQuery(body.toString())));
}

// respond()'s arguments for the cork, a function that exists once rather than a closure per
// response. µWS runs it before cork returns, so nothing can get between
/** @type {GuardedResponse} */
let outRes;
/** @type {number} */
let outStatus;
/** @type {Record<string, string|string[]>|null|undefined} */
let outHeaders;
/** @type {Buffer|null} */
let outType;
/** @type {Buffer|null} */
let outEncoding;
/** @type {boolean} */
let outVary;
/** @type {any} */
let outBody;

/** Status and headers: the part of an answer that is the same whatever the body is. */
function writeHead() {
    if (outStatus !== 200) {
        outRes.writeStatus(statusLineBytes(outStatus, undefined));
    }
    if (outHeaders !== null && outHeaders !== undefined) {
        for (const name in outHeaders) {
            const value = outHeaders[name];
            if (typeof value === "string") {
                outRes.writeHeader(HEADER_NAME_BUF[name] || name, HEADER_VALUE_BUF[value] || value);
            } else {
                for (const one of value) {
                    outRes.writeHeader(name, one);
                }
            }
        }
    }
    if (outType !== null) {
        outRes.writeHeader(CONTENT_TYPE, outType);
    }
    if (outEncoding !== null) {
        outRes.writeHeader(CONTENT_ENCODING, outEncoding);
    }
    if (outVary) {
        outRes.writeHeader(VARY, VARY_ACCEPT_ENCODING);
    }
}

/** A whole answer, what respond() corks. */
function writeWhole() {
    writeHead();
    if (outBody === undefined) {
        outRes.endWithoutBody();
    } else {
        outRes.end(outBody);
    }
}

/**
 * Writes an answer whose body is final: a string, bytes or a Readable.
 *
 * @param {GuardedResponse} res
 * @param {number} status
 * @param {Record<string, string|string[]>|null|undefined} headers
 * @param {Buffer|null} type the content-type to add, null when headers carries it
 * @param {Buffer|null} encoding the content-encoding to add
 * @param {boolean} vary whether to add Vary: Accept-Encoding
 * @param {any} body
 * @param {boolean} [corked] whether a whole answer is still under the native callback's cork
 */
function respond(res, status, headers, type, encoding, vary, body, corked = false) {
    outRes = res;
    outStatus = status;
    outHeaders = headers;
    outType = type;
    outEncoding = encoding;
    outVary = vary;
    if (typeof body.pipe === "function") {
        sendStream(res, body);
        return;
    }
    outBody = body;
    if (corked) {
        writeWhole();
    } else {
        res.cork(writeWhole);
    }
    outBody = null;
}

/**
 * A whole answer of app.uwsLite(), where the handler may still be under µWS's own cork. The type is
 * text, an undefined body is no body at all.
 *
 * @param {GuardedResponse} res
 * @param {number} status
 * @param {Record<string, string|string[]>|null} headers
 * @param {string|null} type
 * @param {string|Uint8Array|undefined} body
 * @param {boolean} corked
 */
function respondWhole(res, status, headers, type, body, corked) {
    outRes = res;
    outStatus = status;
    outHeaders = headers;
    outType = type === null ? null : HEADER_VALUE_BUF[type] || /** @type {any} */ (type);
    outEncoding = null;
    outVary = false;
    outBody = body;
    if (corked) {
        writeWhole();
    } else {
        res.cork(writeWhole);
    }
    outBody = null;
}

/**
 * The content-type a body implies, when it is something send() can pass on as it is. JSON is the
 * rest, which send() serializes.
 *
 * @param {unknown} body
 * @returns {string}
 */
function impliedType(body) {
    if (typeof body === "string") {
        return TEXT_TYPE;
    }
    if (
        body instanceof Uint8Array ||
        body instanceof ArrayBuffer ||
        typeof (/** @type {any} */ (body).pipe) === "function"
    ) {
        return OCTET_TYPE;
    }
    return JSON_TYPE;
}

/**
 * The response in one call: status, headers and body, which is a string, bytes, a Readable, or
 * anything else as JSON. A body with no content-type in headers (lowercase) gets the one it implies.
 * After an abort it does nothing, so it is safe from a callback that outlived the client, provided
 * guard() or a read function ran before the handler returned.
 *
 * @param {GuardedResponse} res
 * @param {number} status
 * @param {Record<string, string>|null} [headers]
 * @param {unknown} [body]
 */
function send(res, status, headers, body) {
    if (res.aborted === true) {
        return;
    }
    const empty = body === undefined || body === null;
    const type = empty ? null : impliedType(body);
    respond(
        res,
        status,
        headers,
        type === null || headers?.["content-type"] !== undefined ? null : HEADER_VALUE_BUF[type],
        null,
        false,
        empty ? "" : type === JSON_TYPE ? JSON.stringify(body) : body
    );
}

/**
 * Chunked, with µWS's backpressure: paused when a write did not fit, on again at onWritable. The
 * head waits for the first chunk, so a stream that fails before any byte can still answer 500.
 *
 * @param {GuardedResponse} res
 * @param {any} stream
 */
function sendStream(res, stream) {
    const status = outStatus;
    const headers = outHeaders;
    const type = outType;
    const encoding = outEncoding;
    const vary = outVary;
    let headed = false;
    let ended = false;
    /** @param {Buffer} chunk */
    const writeChunk = (chunk) => {
        if (!headed) {
            headed = true;
            outRes = res;
            outStatus = status;
            outHeaders = headers;
            outType = type;
            outEncoding = encoding;
            outVary = vary;
            writeHead();
        }
        if (!res.write(chunk)) {
            stream.pause();
            res.onWritable(() => {
                stream.resume();
                return true;
            });
        }
    };
    guard(res);
    res._abortHook = () => stream.destroy();
    stream.on("data", (/** @type {Buffer} */ chunk) => {
        res.cork(() => writeChunk(chunk));
    });
    stream.on("end", () => {
        if (ended || res.aborted) {
            return;
        }
        ended = true;
        res.cork(() => {
            if (!headed) {
                writeChunk(Buffer.alloc(0));
            }
            res.end();
        });
    });
    stream.on("error", () => {
        if (ended || res.aborted) {
            return;
        }
        ended = true;
        if (headed) {
            // the head is gone, so the client has to see a broken response and not a short one
            res.close();
        } else {
            refuse(res, 500);
        }
    });
}

/**
 * express.compression() for an app.uws() route: the same options but filter, which is written against
 * Request and Response, and the same reused encoders. negotiate() reads req, so before the handler
 * returns, and its answer goes to send().
 *
 * @param {any} [options]
 * @returns {{
 *   negotiate: (req: UwsRequest) => string,
 *   send: (res: GuardedResponse, status: number, headers: Record<string, string>|null|undefined, body: unknown, encoding: string) => void,
 *   _deliver: (res: GuardedResponse, status: number, headers: Record<string, string|string[]>|null|undefined, type: string, body: string|Uint8Array, encoding: string, corked?: boolean) => void
 * }}
 */
function compressor(options) {
    const { enforceEncoding, threshold, allowed, compressWhole, compressWholeAsync, compressStream } =
        compression._makeEncoders(options);

    return {
        negotiate(req) {
            const accept = req.getHeader(ACCEPT_ENCODING);
            const chosen = accept === "" ? enforceEncoding : negotiateEncoding(accept, allowed);
            return chosen === "identity" ? "" : chosen;
        },
        send(res, status, headers, body, encoding) {
            if (res.aborted === true) {
                return;
            }
            if (body === undefined || body === null) {
                send(res, status, headers, body);
                return;
            }
            const implied = impliedType(body);
            const own = headers?.["content-type"];
            if (!compression._isCompressible(own ?? implied)) {
                send(res, status, headers, body);
                return;
            }
            const payload = implied === JSON_TYPE ? JSON.stringify(body) : body;
            deliver(res, status, headers, own === undefined ? HEADER_VALUE_BUF[implied] : null, payload, encoding);
        },
        _deliver(res, status, headers, type, body, encoding, corked) {
            deliver(res, status, headers, HEADER_VALUE_BUF[type] || /** @type {any} */ (type), body, encoding, corked);
        }
    };

    /**
     * A body of a compressible type, already a string, bytes or a Readable.
     *
     * @param {GuardedResponse} res
     * @param {number} status
     * @param {Record<string, string|string[]>|null|undefined} headers
     * @param {Buffer|null} type
     * @param {any} payload
     * @param {string} encoding
     * @param {boolean} [corked] valid only while delivery stays synchronous
     */
    function deliver(res, status, headers, type, payload, encoding, corked = false) {
        if (encoding === "") {
            respond(res, status, headers, type, null, true, payload, corked);
            return;
        }
        const encodingBytes = HEADER_VALUE_BUF[encoding];
        if (typeof payload.pipe === "function") {
            const encoder = compressStream(encoding);
            pipeline(payload, encoder, noop);
            respond(res, status, headers, type, encodingBytes, true, encoder);
            return;
        }
        const input = typeof payload === "string" ? Buffer.from(payload) : payload;
        if (input.length < threshold) {
            respond(res, status, headers, type, null, true, input, corked);
            return;
        }
        if (input.length <= compression._SYNC_LIMIT) {
            respond(res, status, headers, type, encodingBytes, true, compressWhole(encoding, input), corked);
            return;
        }
        // the pool answers after the handler returned
        guard(res);
        compressWholeAsync(encoding, input, (error, compressed) => {
            if (res.aborted === true) {
                return;
            }
            if (error) {
                refuse(res, 500);
                return;
            }
            respond(res, status, headers, type, encodingBytes, true, compressed);
        });
    }
}

/** What pipeline() wants, the stream's own error listener does the answering. */
function noop() {}

module.exports = {
    query,
    guard,
    readBuffer,
    readText,
    readJson,
    readForm,
    send,
    compressor,
    _respond: respond,
    _respondWhole: respondWhole
};
