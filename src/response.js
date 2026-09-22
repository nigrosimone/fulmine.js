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

const cookie = require("cookie");
const mime = require("mime-types");
const vary = require("vary");
const encodeUrl = require("encodeurl");
const contentDisposition = require("content-disposition");
const {
    normalizeType,
    stringify,
    UP_PATH_REGEXP,
    decode,
    containsDotFile,
    isPreconditionFailure,
    isRangeFresh,
    escapeHtml,
    validateHeaderName,
    validateHeaderValue,
    headerIsWritable,
    withUtf8Charset,
    asStatError,
    httpError,
    headersSentError,
    applyWriteHead,
    contentTypeFor,
    contentTypeSet,
    statTag,
    cachedStat,
    NullObject
} = require("./utils.js");
const { isAbsolute } = require("path");
const fs = require("fs");
const Path = require("path");
const statuses = require("statuses");
const { sign } = require("cookie-signature");
const ms = require("ms");
const Socket = require("./socket.js");
const { LazyWritable } = require("./lazy-writable.js");
const {
    kOutHeaders,
    kShapeMode,
    VALIDATED_HEADER_NAMES,
    HEADER_NAME_BUF,
    HEADER_VALUE_BUF,
    statusLine,
    invalidChunkError
} = require("./response-utils.js");

// How much a chunked response may gather before it goes to uWS: 33 KB in 500 pieces measured
// 16.2ms one piece at a time, 0.79ms in 4 KB blocks, 0.43ms in 8 KB, 0.45ms in 16 KB
const COALESCE_LIMIT = 16 * 1024;

// A chunk from here up goes straight through: merging costs a copy, and 33 KB in eight pieces
// got 28% dearer gathered, in sixty-six pieces 3.4x cheaper
const COALESCE_BELOW = 4 * 1024;

const HIGH_WATERMARK = 128 * 1024;
// the exact string json() writes, so send() can skip recomputing the charset on it
const JSON_UTF8 = "application/json; charset=utf-8";

// the seeded Keep-Alive, a constant so setHeader can tell it from one the application set
const SEEDED_KEEP_ALIVE = "timeout=10";
// the seeded connection and keep-alive as one value, every response writes them in one call:
// 572ns to 438 per head with a content-type, on node 26
const SEEDED_PAIR = "keep-alive\r\nkeep-alive: " + SEEDED_KEEP_ALIVE;
const SEEDED_PAIR_BUF = Buffer.from(SEEDED_PAIR);
// send's ceiling for maxAge, one year
const MAX_MAXAGE = 60 * 60 * 24 * 365 * 1000;

// what send takes as a range request, checked on the header's text before parsing
const BYTES_RANGE = /^ *bytes=/;

// node's test for a Transfer-Encoding that means chunked framing
const CHUNKED_VALUE = /(?:^|\W)chunked(?:$|\W)/i;

module.exports = class Response extends LazyWritable {
    /** @type {Socket|null} */
    #socket = null;

    /** Whether end() has run, so a second one is a no-op. */
    #ended = false;

    /** @type {((err?: Error|null) => void)|null} */
    #pendingCallback = null;

    /**
     * An end() that arrived while uWS still held a chunk, run once that chunk is through. Not
     * waited for on 'drain': node emits it only after a write() that said false, and a piece
     * under the high-water mark never says it, so a stream ending on a small piece a slow client
     * had not taken yet was never closed (compression-file under load, 2026-09-21).
     * @type {(() => void)|null}
     */
    #deferredEnd = null;

    /**
     * Chunks written but not yet handed to uWS: a write costs uWS everything buffered behind it, so
     * many small pieces cost quadratically, 500 writes of 66 bytes measured 13ms against 0.4ms in
     * blocks. Null until the first chunked write.
     * @type {Buffer[]|null}
     */
    #queued = null;

    /** The bytes in {@link #queued}. */
    #queuedBytes = 0;

    /** Whether a flush is booked for the end of this turn. */
    #flushBooked = false;

    /** Whether the status line and the headers have reached uWS, which only a body write does. */
    #headOut = false;

    /**
     * Whether the application set Transfer-Encoding: chunked itself. The body then goes out
     * through uWS's write(), which frames it and writes the header, and no Content-Length is
     * added beside it, as express 5.3 and node do. See writeHeaders and _finish.
     */
    #userChunked = false;

    /**
     * The status as writeHead settled it, the one the wire gets: a status set later never reaches
     * the client, as in node.
     * @type {number}
     */
    #status = 200;

    /** @type {string|undefined} */
    #statusText = undefined;

    /** @type {Response["headers"]|null} */
    #outHeaders = null;

    /** @type {InstanceType<typeof import("./request.js")>} */
    req;

    /**
     * The EventEmitter half stays eager, the constructor writes its two listeners straight into
     * this map. Same five keys in node's own order, so the hidden class is every other stream's.
     * @type {Record<string, Function|undefined>}
     */
    _events = {
        close: undefined,
        error: undefined,
        prefinish: undefined,
        finish: undefined,
        drain: undefined
    };

    /** @type {number} */
    _eventsCount = 0;

    /** Tombstone removed listeners, as node's streams do: a delete flipped _events to dictionary mode. */
    [kShapeMode] = true;

    /** on-finished stores its state here, declared so the store is not a shape change. @type {any} */
    __onFinished = null;

    /** @type {InstanceType<typeof import("./request.js")>} */
    _req;

    /** @type {import("uWebSockets.js").HttpResponse} */
    _res;

    /** @type {boolean} */
    headersSent = false;

    /**
     * Whether the wire carries a body, decided from the method that arrived as node does:
     * method-override rewriting req.method later changes what the router matches, not the wire.
     * @type {boolean}
     */
    _hasBody;

    /** @type {import("./application.js").Application} */
    app;

    /** @type {Record<string, any>} */
    locals = new NullObject();

    /** Whether end() ran through, or the response was torn down. @type {boolean} */
    finished = false;

    /** @type {boolean} */
    aborted = false;

    /** @type {number} */
    statusCode = 200;

    /** @type {string|undefined} */
    statusText = undefined;

    /** Whether the body goes out chunked, false once a Content-Length is known, see writeHeaders. @type {boolean} */
    chunkedTransfer = true;

    /** The Content-Length handed to uWS, see writeHeaders. @type {number} */
    totalSize = 0;

    /** Whether a chunk is still in uWS's hands, so the next write waits for the drain. @type {boolean} */
    writingChunk = false;

    /** The headers set so far, by lowercase name. @type {Record<string, any>} */
    headers;

    /** A slot for whatever a middleware puts on res.body, never read here. @type {unknown} */
    body = undefined;

    /**
     * What was handed to uWS, for a content-length asked after the fact, see get().
     * @type {string|Buffer|Uint8Array|undefined}
     */
    _sentBody = undefined;

    /** False while the uWS route handler is in its synchronous window, where uWS corks itself. @type {boolean} */
    _corkNeeded = false;

    /**
     * The app's pending list that close() drains, intrusive and doubly linked, see
     * Application#handleRequest. Declared here: linked after construction, the three were a
     * shape change on every response.
     * @type {boolean}
     */
    _pendingLinked = false;

    /** @type {Response|null} */
    _pendingPrev = null;

    /** @type {Response|null} */
    _pendingNext = null;

    /**
     * Built for every request, right after its Request.
     *
     * @param {import("uWebSockets.js").HttpResponse} res the uWS response
     * @param {InstanceType<typeof import("./request.js")>} req the Request, already built
     * @param {import("./application.js").Application} app the application this request arrived at
     */
    constructor(res, req, app) {
        super();
        this._req = req;
        this.req = req;
        this._res = res;
        this._hasBody = req._isHead !== true;
        this.app = app;
        // timeout=10 is uWS's idle timeout. On the node shim node writes its own pair; "connection
        // headers" off advertises neither, as Express always does
        this.headers =
            res._nodeRes || app._settings["connection headers"] === false
                ? {}
                : {
                      connection: "keep-alive",
                      "keep-alive": SEEDED_KEEP_ALIVE
                  };
        // the client asked to close and uWS closes: a declarative response, written once, cannot say so
        if (req._connectionClose) {
            this.headers.connection = "close";
        }
        if (app._hot().xPoweredBy) {
            this.headers["x-powered-by"] = "Fulmine";
        }
        // shared methods, not arrows: two closures and a once() were four allocations per request.
        // Written into _events directly, which arrives shaped with these keys undefined: the two
        // on() calls were 6% of a hello-world. Only on a fresh response, anything else uses on()
        const self = this;
        const events = self._events;
        if (
            self._eventsCount === 0 &&
            events !== undefined &&
            events.error === undefined &&
            events.close === undefined
        ) {
            events.error = this._onAbortError;
            events.close = this._onCloseCleanup;
            self._eventsCount = 2;
        } else {
            this.on("error", this._onAbortError);
            this.on("close", this._onCloseCleanup);
        }
    }

    /** @param {Error} err */
    _onAbortError(err) {
        if (this.finished) {
            return;
        }
        this._res.cork(() => {
            this._res.close();
            this.finished = true;
            this.#socket?.emit("close");
        });
        // no 'close' is emitted here, so the pending list is unlinked by hand: a server never
        // closed kept every aborted response
        this._unlinkPending();
    }

    /**
     * Drops the connection, as node destroys the socket: a download whose source died must leave
     * the client a reset, not a truncated body (LibreChat: `stream.on("error", () => res.destroy())`).
     * A finished or aborted response only tears the stream down, touching an aborted uWS response
     * is a use after free. writableEnded reads true after this, node keeps it false until end().
     *
     * @override
     * @param {Error} [error] whatever the caller is destroying the response with
     * @returns {this}
     */
    destroy(error) {
        if (this.finished !== true && this.aborted !== true) {
            this.finished = true;
            this._res.close();
        }
        return super.destroy(error);
    }

    /** Idempotent: end() emits 'close' by hand and a later destroy() makes Writable emit it again. */
    _onCloseCleanup() {
        this.#ended = true;
        this._unlinkPending();
    }

    /**
     * Takes this response out of the app's pending list that close() drains. The list head is in a
     * holder on the per-app prototype layer, see the Application constructor.
     */
    _unlinkPending() {
        if (this._pendingLinked !== true) {
            return;
        }
        this._pendingLinked = false;
        const pending = /** @type {{_pendingIn?: {head: Response|null}}} */ (this)._pendingIn;
        const prev = this._pendingPrev;
        const next = this._pendingNext;
        if (prev) {
            prev._pendingNext = next;
        } else if (pending && pending.head === this) {
            pending.head = next;
        }
        if (next) {
            next._pendingPrev = prev;
        }
        this._pendingPrev = null;
        this._pendingNext = null;
    }

    /**
     * Where node keeps an OutgoingMessage's headers, which only node's own header path reads
     * (cookie-session). A proxy built on the first look, it was two closures per response before.
     * A setter too, node assigns to this slot on a reset.
     */
    get [kOutHeaders]() {
        if (!this.#outHeaders) {
            this.#outHeaders = new Proxy(this.headers, {
                // node keys the slot by lowercased name, and stores [name, value]
                set: (obj, prop, value) => {
                    this.set(/** @type {string} */ (prop), value[1]);
                    return true;
                },
                get: (obj, prop) => {
                    return obj[/** @type {string} */ (prop)];
                }
            });
        }
        return this.#outHeaders;
    }

    /** @param {Response["headers"]|null} value */
    set [kOutHeaders](value) {
        this.#outHeaders = value;
    }

    /**
     * A socket-shaped object for middleware that reaches for one, null once the response is over
     * as in node.
     * @returns {Socket|null}
     */
    get socket() {
        if (this.#ended) return null;
        return this._socketShim();
    }

    /**
     * The stand-in itself, built on first ask: the request's `socket` is the same object and stays
     * after the response is over, so it comes through here.
     *
     * @returns {Socket}
     */
    _socketShim() {
        if (!this.#socket) {
            this.#socket = new Socket(this);
        }
        return this.#socket;
    }

    /**
     * Whether that socket was ever built, for src/work.js, readable after the response is over.
     * @returns {boolean}
     */
    get _socketBuilt() {
        return this.#socket !== null;
    }

    /**
     * Hands everything queued to uWS as one write, with the backpressure a single write had.
     *
     * @param {((err?: Error|null) => void)|null} callback the stream's, when there is one waiting
     */
    #flushQueued(callback) {
        if (this.#queued === null || this.#queuedBytes === 0) {
            if (callback) callback(null);
            return;
        }
        const body = this.#queued.length === 1 ? this.#queued[0] : Buffer.concat(this.#queued, this.#queuedBytes);
        this.#queued = null;
        this.#queuedBytes = 0;

        const ok = this._res.write(body);
        if (ok) {
            this.writingChunk = false;
            if (callback) callback(null);
            else this.emit("drain");
        } else if (callback) {
            this.#pendingCallback = callback;
            this._res.onWritable(() => {
                if (this.aborted || this.finished) return true;
                const cb = this.#pendingCallback;
                this.#pendingCallback = null;
                this.writingChunk = false;
                if (cb) cb(null);
                this.#afterPending();
                return true;
            });
        } else {
            // nothing is waiting on this one: uWS drains it and the next write finds out
            this.writingChunk = false;
        }
    }

    /**
     * After a held chunk went through and the stream's callback ran: the callback may have pushed
     * the next buffered piece into uWS's hands, so the waiting end() runs only when nothing is.
     */
    #afterPending() {
        if (this.#deferredEnd !== null && !this.writingChunk) {
            const end = this.#deferredEnd;
            this.#deferredEnd = null;
            end();
        }
    }

    /**
     * The booked flush. Static, so a response that never writes in pieces allocates no closure.
     *
     * @param {any} res loose: the class named inside its own body reads as two `this` types
     */
    static #flushOnTick(res) {
        res.#flushBooked = false;
        if (res.aborted || res.finished || res.#queuedBytes === 0) return;
        res._res.cork(() => res.#flushQueued(null));
    }

    /**
     * Writable's sink: the head if not out yet, then the chunk to uWS through the queue for a
     * chunked response or tryEnd with a Content-Length. Backpressure defers the callback.
     *
     * @override
     * @param {any} chunk whatever a Writable was handed
     * @param {BufferEncoding} encoding
     * @param {(err?: Error|null) => void} callback
     */
    _write(chunk, encoding, callback) {
        if (this.aborted) {
            /** @type {NodeJS.ErrnoException} */
            const err = new Error("Request aborted");
            err.code = "ECONNABORTED";
            this.destroy(err);
            return;
        }
        if (this.finished) {
            const err = new Error("Response already finished");
            this.destroy(err);
            return;
        }

        this.writingChunk = true;
        this._res.cork(() => {
            if (!this.#headOut) {
                if (!this.headersSent) {
                    this.writeHead(this.statusCode);
                }
                // a plain 200 is uWS's own head, so it is not written at all
                if (this.#status !== 200 || this.#statusText !== undefined) {
                    this._res.writeStatus(statusLine(this.#status, this.#statusText));
                }
                this.writeHeaders(typeof chunk === "string");
            }

            if (!Buffer.isBuffer(chunk) && !(chunk instanceof ArrayBuffer)) {
                chunk = Buffer.from(chunk);
            }

            if (this.chunkedTransfer) {
                // gathered and handed over at the end of this turn, or once big enough: an SSE feed
                // writing once per turn still leaves on its own turn
                (this.#queued ??= []).push(/** @type {Buffer} */ (chunk));
                this.#queuedBytes += /** @type {Buffer} */ (chunk).byteLength;
                if (this.#queuedBytes >= COALESCE_LIMIT || /** @type {Buffer} */ (chunk).byteLength >= COALESCE_BELOW) {
                    this.#flushQueued(callback);
                } else {
                    if (!this.#flushBooked) {
                        this.#flushBooked = true;
                        process.nextTick(Response.#flushOnTick, this);
                    }
                    this.writingChunk = false;
                    callback(null);
                }
            } else {
                const lastOffset = this._res.getWriteOffset();
                const [ok, done] = this._res.tryEnd(chunk, this.totalSize);
                if (done) {
                    super.end();
                    this.finished = true;
                    this.writingChunk = false;
                    this.#socket?.emit("close");
                    callback(null);
                } else if (!ok) {
                    this._res.ab = chunk;
                    this._res.abOffset = lastOffset;
                    let handlerUsed = false;
                    this._res.onWritable((offset) => {
                        if (this.finished || handlerUsed) return true;
                        const [ok, done] = this._res.tryEnd(
                            this._res.ab.slice(offset - this._res.abOffset),
                            this.totalSize
                        );
                        if (done) {
                            this.finished = true;
                            this.#socket?.emit("close");
                        }
                        if (ok) {
                            this.writingChunk = false;
                            handlerUsed = true;
                            callback(null);
                            this.#afterPending();
                        }
                        return ok;
                    });
                } else {
                    this.writingChunk = false;
                    callback(null);
                }
            }
        });
    }

    /**
     * Sets the status and optionally the headers, the way node does: the head is settled here,
     * headersSent reads true, a later set throws. Every header goes through setHeader, not set:
     * this is node's method, so a content-type keeps its value with no charset appended, which is
     * what @astrojs/node and @sveltejs/adapter-node expect of their pages.
     *
     * @param {number} statusCode
     * @param {string|import("http").OutgoingHttpHeaders|import("http").OutgoingHttpHeader[]} [statusMessage] the
     *   reason phrase, or the headers
     * @param {import("http").OutgoingHttpHeaders|import("http").OutgoingHttpHeader[]} [headers]
     * @returns {this}
     */
    writeHead(statusCode, statusMessage, headers) {
        if (this.headersSent) {
            throw headersSentError("write");
        }
        this.statusCode = statusCode;
        let reason;
        try {
            reason = applyWriteHead(this, statusMessage, headers);
        } catch (err) {
            // node keeps the phrase settled before the headers threw: a 500 after that goes out "500 OK"
            if (!this.statusText) {
                this.statusText = typeof statusMessage === "string" ? statusMessage : statuses.message[statusCode];
            }
            throw err;
        }
        if (reason !== undefined) {
            this.statusText = reason;
        }
        this.#status = statusCode;
        this.#statusText = this.statusText;
        this.headersSent = true;
        return this;
    }

    /**
     * Writes every header set so far to uWS, the point of no return. Content-Length is kept on
     * totalSize instead: uWS takes the length through tryEnd or endWithoutBody.
     *
     * From the third line on the head goes in one writeHeader, joined in the first value, as uWS
     * writes `name: value\r\n` without reading it. Per head on node 26: helmet's set 3953ns to 1327,
     * five lines 1013 to 531. One or two lines keep a call each, the join costs what it saves (issue #11).
     *
     * @param {boolean} utf8 unused, kept because node's equivalent takes it and the two callers
     *   differ on what they know about the body
     */
    writeHeaders(utf8) {
        // node leaves Keep-Alive out once the connection is closing, whoever set Connection
        const headers = this.headers;
        const res = this._res;
        const connection = headers["connection"];
        // length first: the value is nearly always "keep-alive", which paid a lowercase per response
        const closing =
            typeof connection === "string" && connection.length === 5 && connection.toLowerCase() === "close";
        // the node shim writes a line with node's appendHeader, that refuses the CRLF of a join
        const joins = res._nodeRes === undefined;
        // lines not written yet: the first two apart, from the third on in joined
        let lines = 0;
        let pair = false;
        let firstName = "";
        let firstValue = "";
        let secondName = "";
        let secondValue = "";
        let joined = "";
        // for..in over an object a few responses delete from (204, 304, 205, a 304 file,
        // removeHeader), rare enough to keep the shape, unlike the request side
        for (const header in headers) {
            if (closing && header === "keep-alive") {
                continue;
            }
            const value = headers[header];
            if (header === "content-length") {
                this.chunkedTransfer = false;
                this.totalSize = parseInt(value);
                continue;
            }
            if (
                header === "transfer-encoding" &&
                typeof value === "string" &&
                res._nodeRes === undefined &&
                CHUNKED_VALUE.test(value)
            ) {
                // not written: uWS writes its own on the write() path, two came out before. Node's
                // own response, behind the shim, frames by the header itself
                this.#userChunked = true;
                continue;
            }
            // a string first, nearly every value is one
            const isText = typeof value === "string";
            const list = isText || !Array.isArray(value) ? null : value;
            // only text is joined, the rest crosses alone as before. false is joined as "false", the
            // content-type res.set stores for an unknown type
            let joinable = joins && (isText || list !== null || value === false);
            if (joinable && list !== null) {
                for (let i = 0; i < list.length; i++) {
                    if (typeof list[i] !== "string") {
                        joinable = false;
                        break;
                    }
                }
            }
            if (!joinable) {
                // the lines before this one go first, so the order on the wire holds
                if (lines !== 0) {
                    Response.#writeLines(res, lines, pair, firstName, firstValue, secondName, secondValue, joined);
                    lines = 0;
                    pair = false;
                }
                // the recurring names and values cross as cached Buffers, see HEADER_NAME_BUF
                const name = HEADER_NAME_BUF[header] || header;
                if (list !== null) {
                    for (const val of list) {
                        res.writeHeader(name, HEADER_VALUE_BUF[val] || val);
                    }
                } else {
                    res.writeHeader(name, HEADER_VALUE_BUF[value] || value);
                }
                continue;
            }
            const count = list === null ? 1 : list.length;
            for (let i = 0; i < count; i++) {
                const text = list === null ? (value === false ? "false" : value) : list[i];
                if (
                    lines === 1 &&
                    !pair &&
                    header === "keep-alive" &&
                    text === SEEDED_KEEP_ALIVE &&
                    firstName === "connection" &&
                    firstValue === "keep-alive"
                ) {
                    // the seeded pair, one line from here on
                    pair = true;
                    continue;
                }
                if (lines === 0) {
                    firstName = header;
                    firstValue = text;
                } else if (lines === 1) {
                    secondName = header;
                    secondValue = text;
                } else if (lines === 2) {
                    joined =
                        (pair ? SEEDED_PAIR : firstValue) +
                        "\r\n" +
                        secondName +
                        ": " +
                        secondValue +
                        "\r\n" +
                        header +
                        ": " +
                        text;
                } else {
                    joined += "\r\n" + header + ": " + text;
                }
                lines++;
            }
        }
        if (lines !== 0) {
            Response.#writeLines(res, lines, pair, firstName, firstValue, secondName, secondValue, joined);
        }
        this.headersSent = true;
        this.#headOut = true;
    }

    /**
     * Writes the lines of writeHeaders: one or two a call each, three or more in one call.
     *
     * @param {import("uWebSockets.js").HttpResponse} res
     * @param {number} lines how many, the seeded pair counted as one
     * @param {boolean} pair whether the first line is the seeded pair
     * @param {string} firstName
     * @param {string} firstValue
     * @param {string} secondName
     * @param {string} secondValue
     * @param {string} joined the first value with the other lines after it
     */
    static #writeLines(res, lines, pair, firstName, firstValue, secondName, secondValue, joined) {
        const name = HEADER_NAME_BUF[firstName] || firstName;
        if (lines > 2) {
            res.writeHeader(name, joined);
            return;
        }
        res.writeHeader(name, pair ? SEEDED_PAIR_BUF : HEADER_VALUE_BUF[firstValue] || firstValue);
        if (lines === 2) {
            res.writeHeader(HEADER_NAME_BUF[secondName] || secondName, HEADER_VALUE_BUF[secondValue] || secondValue);
        }
    }

    /**
     * node's, called before a body when writeHead never was. Guarded here: the compression module
     * calls it on the strength of node's _header, which this response does not keep.
     */
    _implicitHeader() {
        if (!this.headersSent) {
            this.writeHead(this.statusCode);
        }
    }

    /**
     * Sets the status code.
     * @param {number} code an integer from 100 to 999
     * @returns {this} the response, for chaining
     * @throws {TypeError} if the code is not an integer, "200" included
     * @throws {RangeError} if it is an integer outside the range
     */
    status(code) {
        // Express 5's two refusals and its messages: a TypeError for the type, a RangeError for the number
        if (!Number.isInteger(code)) {
            throw new TypeError(`Invalid status code: ${JSON.stringify(code)}. Status code must be an integer.`);
        }
        if (code < 100 || code > 999) {
            throw new RangeError(
                `Invalid status code: ${JSON.stringify(code)}. Status code must be greater than 99 and less than 1000.`
            );
        }
        this.statusCode = code;
        return this;
    }

    /**
     * Sets the status and sends its standard message as the body, so 404 answers "Not Found".
     * @param {number} code
     * @returns {this}
     */
    sendStatus(code) {
        return this.status(code)
            .type("txt")
            .send(statuses.message[code] || String(code));
    }

    /**
     * @override
     * @param {string|Buffer|Uint8Array|null|(() => void)} [data] the last body piece, or the callback in
     *   node's one-argument shape
     * @param {BufferEncoding|(() => void)} [encoding] how a string body is encoded, or the callback in
     *   node's two-argument shape
     * @param {() => void} [cb]
     * @returns {this}
     */
    end(data, encoding, cb) {
        if (typeof data === "function") {
            cb = data;
            data = undefined;
            encoding = undefined;
        } else if (typeof encoding === "function") {
            cb = encoding;
            encoding = undefined;
        }
        if (typeof cb !== "function") {
            cb = undefined;
        }
        // node refuses a chunk that is not a string, a Buffer or a Uint8Array, and writes it only
        // `if (chunk)`, so end(0) sends nothing. typeof first, a string body is nearly every body
        if (typeof data !== "string" && data !== undefined && !(data instanceof Uint8Array)) {
            if (data) {
                throw invalidChunkError(data);
            }
            data = undefined;
        }
        // uWS takes a string as utf-8 only: res.end(data, "binary") is how old code sends an image
        if (typeof data === "string" && encoding !== undefined && encoding !== "utf8" && encoding !== "utf-8") {
            data = Buffer.from(data, /** @type {BufferEncoding} */ (encoding));
        }

        if (this.writingChunk) {
            this.#deferredEnd = () => this.end(data, cb);
            return this;
        }
        if (this.finished) {
            return this;
        }
        // as node's end() calls _implicitHeader
        if (!this.headersSent) {
            this.writeHead(this.statusCode);
        }
        // uWS corks itself for the synchronous window of its route handler, see _corkNeeded
        // by now a function was moved to cb, which the editor's config cannot see
        const chunk = /** @type {string|Uint8Array|null|undefined} */ (data);
        if (this._corkNeeded) {
            this._res.cork(() => this._finish(chunk, cb));
        } else {
            this._finish(chunk, cb);
        }
        return this;
    }

    /**
     * The corked tail of end(): status, headers, body and the finish events.
     *
     * @param {string|Buffer|Uint8Array|null|undefined} data the last body piece
     * @param {(() => void)|undefined} cb
     */
    _finish(data, cb) {
        // read before the head is written below: whether a flushHeaders() or a res.write() had
        // already committed the framing
        const headWasAlreadyOut = this.#headOut;
        if (!this.#headOut) {
            // freshness is decided in send() and sendFile(), as in Express, not here: node's end()
            // knows nothing of conditional requests. "unknown" for a code without a message, as
            // node writes it; a plain 200 is not written at all, uWS emits the same head itself
            if (this.#status !== 200 || this.#statusText !== undefined) {
                this._res.writeStatus(statusLine(this.#status, this.#statusText));
            }
            this.writeHeaders(true);
        }
        const contentLength = this.headers["content-length"];
        // The client said the connection ends here: uWS closes by itself for a bare "close", not
        // for "keep-alive, close", see saysClose. Only with a length: endWithoutBody reads its
        // first argument as the length, and closing without one wrote a 2^63 Content-Length on a 204
        const closeConnection = this.req._connectionClose === true;
        // 204, 304 and 1xx carry no body whatever the caller passed, as node decides it too
        if (this.#status === 204 || this.#status === 304 || this.#status < 200) {
            this._res.endWithoutBody();
        } else if (!data && contentLength) {
            this._res.endWithoutBody(contentLength.toString(), closeConnection);
        } else if ((headWasAlreadyOut && this.chunkedTransfer) || (this.#userChunked && this._hasBody && data)) {
            // the queue first, then the last piece as a chunk: the head already went out without a
            // length, or the application asked for chunked framing, and uWS's end() would append one.
            // An empty body under that header takes end() below: uWS frames nothing without a write()
            this.#flushQueued(null);
            if (data) {
                this._res.write(data);
                this._sentBody = data;
            }
            this._res.endWithoutBody();
        } else {
            if (!this._hasBody) {
                if (this.#userChunked) {
                    // a HEAD under the application's chunked framing carries no length, as node.
                    // No arguments: given a close flag alone, uWS writes a 2^63 length
                    this._res.endWithoutBody();
                } else {
                    const length = Buffer.byteLength(data ?? "");
                    this.headers["content-length"] = String(length);
                    this._res.endWithoutBody(length, closeConnection);
                }
            } else {
                this._sentBody = data ?? "";
                // null is the empty body: uWS never ends a response given end(null)
                this._res.end(data ?? "", closeConnection);
            }
        }

        this.finished = true;
        this.#socket?.emit("close");
        this.emit("finish");
        this.emit("close");
        cb &&
            queueMicrotask(() => {
                this.#ended = true;
                cb();
            });
    }

    /**
     * Sends the body, with a Content-Type when none was set and an ETag when the setting asks.
     * A number is a value to serialise, never a status: that is `sendStatus()`.
     *
     * @param {string|number|boolean|object|null} [body] a Buffer or a Uint8Array is sent as bytes,
     *   any other object is serialised
     * @returns {this}
     */
    send(body) {
        // send() with nothing passed: no content-type, no ETag, and no refusal of a head already
        // out, which express answers after a res.write()
        if (body === undefined) {
            if (!this.headersSent) {
                // freshness and the bodiless statuses, as every express send goes through
                if (this.req.fresh) {
                    this.status(304);
                }
                if (this.statusCode === 204 || this.statusCode === 304) {
                    delete this.headers["content-type"];
                    delete this.headers["content-length"];
                    delete this.headers["transfer-encoding"];
                }
            } else if (this.req.fresh || this.statusCode === 204 || this.statusCode === 304) {
                // express strips the content headers through removeHeader, which node refuses
                // once the head is out; a fresh request is made a 304 first and lands here too
                throw headersSentError("remove");
            } else if (this.statusCode === 205) {
                throw headersSentError("set");
            }
            return this.end("");
        }
        if (this.headersSent) {
            throw headersSentError("set");
        }
        // a Uint8Array is bytes to send, not an object to serialise. Only Uint8Array, as node's
        // write accepts: a DataView comes out of express as an empty body
        if (body instanceof Uint8Array && !Buffer.isBuffer(body)) {
            body = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
        }
        const isBuffer = Buffer.isBuffer(body);
        // null becomes "" without the content-type a string gets, as Express's switch has it
        let skipContentType = false;
        if (body === null) {
            body = "";
            skipContentType = true;
        } else if (typeof body === "object" && !isBuffer) {
            return this.json(body);
        } else if (typeof body === "number") {
            return this.json(body);
        } else if (typeof body === "boolean") {
            return this.json(body);
        } else if (!isBuffer && typeof body !== "string") {
            // a symbol, a bigint or a function: what node's byteLength or from() throws is the
            // answer. A string never gets here, measuring it twice cost 157us per thousand requests
            const unsendable = /** @type {any} */ (body);
            const generateETag = !this.headers["etag"] && typeof this.app._hot().etagFn === "function";
            if (!generateETag && unsendable.length < 1000) {
                Buffer.byteLength(unsendable, "utf8");
            }
            Buffer.from(unsendable, "utf8");
        }
        if (typeof body === "string" && !isBuffer) {
            const contentType = this.headers["content-type"];
            if (!contentType) {
                if (!skipContentType) {
                    this.headers["content-type"] = "text/html; charset=utf-8";
                }
            } else if (typeof contentType === "string" && contentType !== JSON_UTF8) {
                // the charset is replaced, the body goes out as utf-8. json()'s literal is already it
                this.headers["content-type"] = withUtf8Charset(contentType);
            }
        } else {
            if (!this.headers["content-type"]) {
                this.headers["content-type"] = "application/octet-stream";
            }
        }
        // the ETag is send()'s, not end()'s: res.end() and res.redirect() carry none, as in node.
        // Set before end() reads req.fresh. An empty body still gets one (send("") and send(null)
        // did not, testing truthiness), and every method, see issue #10
        const hot = this.app._hot();
        const etagFn = hot.etagFn;
        if (
            etagFn &&
            !this.headers["etag"] &&
            !this.req.noEtag &&
            (hot.etagMethods === null || hot.etagMethods.has(this.req.method))
        ) {
            const etag = etagFn(/** @type {string|Buffer} */ (body));
            // an application's own etag function may decline
            if (etag) {
                this.headers["etag"] = etag;
            }
        }
        // after the ETag: freshness compares If-None-Match against it
        if (this.req.fresh) {
            this.status(304);
        }
        // 204 and 304 carry no body and no header describing one; a 205 says so with a length
        if (this.statusCode === 204 || this.statusCode === 304) {
            delete this.headers["content-type"];
            delete this.headers["content-length"];
            delete this.headers["transfer-encoding"];
            body = "";
        } else if (this.statusCode === 205) {
            this.headers["content-length"] = "0";
            delete this.headers["transfer-encoding"];
            body = "";
        }
        // by req.method as express's send does, so a GET a middleware made a HEAD answers its
        // length and no body; end() alone decides by the wire, see _hasBody. No length beside a
        // Transfer-Encoding the application set, as express 5.3
        if (this.req.method === "HEAD") {
            if (this.statusCode !== 204 && this.statusCode !== 304 && !this.headers["transfer-encoding"]) {
                this.headers["content-length"] = String(Buffer.byteLength(/** @type {string|Buffer} */ (body)));
            }
            return this.end();
        }
        return this.end(/** @type {string|Buffer} */ (body));
    }

    /**
     * Streams a file, with the Content-Type of its extension and conditional and range requests
     * answered. The path is absolute unless `options.root` is given. Options: `root`, `maxAge`,
     * `lastModified`, `headers`, `dotfiles`, `acceptRanges`, `cacheControl`, `immutable`, `etag`.
     *
     * @param {string} path
     * @param {import("./options").SendFileOptions|((err?: Error) => void)} [options] or the callback in
     *   its place
     * @param {(err?: Error) => void} [callback] called once sent, or with the error
     */
    sendFile(path, options = new NullObject(), callback) {
        if (!path) {
            throw new TypeError("path argument is required to res.sendFile");
        }
        if (typeof path !== "string") {
            throw new TypeError("path must be a string to res.sendFile");
        }
        if (typeof options === "function") {
            callback = options;
            options = new NullObject();
        }
        if (!options) options = new NullObject();
        // Express's completion handler: a callback hears everything, without one an error goes to
        // the router's next (past the rest of the route) and a directory to a plain next()
        const next = this.req._leaveRoute ?? this.req.next;
        const done = /** @type {(err?: NodeJS.ErrnoException) => void} */ (
            (err) => {
                if (callback) return callback(err);
                if (err && err.code === "EISDIR") return next();
                if (err && err.code !== "ECONNABORTED" && err.syscall !== "write") next(err);
            }
        );
        // default options, normalised as send does: max-age is a non-negative integer of seconds,
        // 0.5, -1 and Infinity are invalid. Number() around ms() too, which answers undefined for
        // a string it cannot read, and Number.isNaN(undefined) is false
        const maxAge = Number(
            typeof options.maxAge === "string"
                ? ms(/** @type {import("ms").StringValue} */ (options.maxAge))
                : options.maxAge
        );
        options.maxAge = Number.isNaN(maxAge) ? 0 : Math.min(Math.max(0, maxAge), MAX_MAXAGE);
        if (typeof options.lastModified === "undefined") {
            options.lastModified = true;
        }
        if (typeof options.cacheControl === "undefined") {
            options.cacheControl = true;
        }
        if (typeof options.acceptRanges === "undefined") {
            options.acceptRanges = true;
        }
        // the app's setting wins over the option, as Express wires send; express.static is the
        // opposite and says so with _ownEtag
        if (!options._ownEtag) {
            options.etag = this.app.get("etag") !== false;
        }

        // path checks
        if (!options.root && !isAbsolute(path)) {
            // thrown, as Express throws it: the calling code is wrong, not the request
            throw new TypeError("path must be absolute or specify root to res.sendFile");
        }
        if (!options.skipEncodePath) {
            path = encodeURI(path);
        }
        const decoded = decode(path);
        if (decoded === -1) {
            return done(httpError(400));
        }
        path = decoded;
        if (~path.indexOf("\0")) {
            return done(httpError(400));
        }
        // send's two branches: with a root an in-root ".." collapses first and only a path still
        // escaping is refused, without a root any ".." is refused on the raw path
        let parts, fullpath;
        if (options.root) {
            path = Path.normalize("." + Path.sep + path);
            if (UP_PATH_REGEXP.test(path)) {
                return done(httpError(403));
            }
            parts = path.split(Path.sep);
            fullpath = Path.resolve(Path.join(options.root, path));
            if (!fullpath.startsWith(Path.resolve(options.root))) {
                return done(httpError(403));
            }
        } else {
            if (UP_PATH_REGEXP.test(path)) {
                return done(httpError(403));
            }
            parts = Path.normalize(path).split(Path.sep);
            fullpath = path;
        }

        // dotfile checks
        if (containsDotFile(parts)) {
            switch (options.dotfiles) {
                case "allow":
                    break;
                case "deny":
                    return done(httpError(403));
                case "ignore_files": {
                    const len = parts.length;
                    if (parts[len - 1].startsWith(".")) {
                        return done(httpError(404));
                    }
                    break;
                }
                case "ignore":
                default:
                    return done(httpError(404));
            }
        }

        let stat = options._stat;
        if (!stat) {
            try {
                stat = cachedStat(fullpath, this.app._settings["stat cache ms"]);
            } catch (err) {
                // the fs error with send's status on it: ENOENT is a 404, unreadable is a 500
                return done(asStatError(/** @type {import("./utils.js").HttpError} */ (err)));
            }
            if (stat.isDirectory()) {
                // an EISDIR with no status, as Express reports a directory; done() makes it a next()
                /** @type {NodeJS.ErrnoException} */
                const err = new Error("EISDIR, read");
                err.code = "EISDIR";
                return done(err);
            }
        }

        // headers
        if (!this.headers["content-type"]) {
            const m = mime.lookup(fullpath);
            if (m) this.type(m);
            else this.type("application/octet-stream");
        }
        if (options.cacheControl) {
            this.headers["cache-control"] =
                `public, max-age=${Math.floor(options.maxAge / 1000)}` + (options.immutable ? ", immutable" : "");
        }
        if (options.lastModified) {
            this.headers["last-modified"] = stat.mtime.toUTCString();
        }
        if (options.headers) {
            for (const header in options.headers) {
                // setHeader, not set: send writes these through node's, so no charset is appended
                this.setHeader(header, options.headers[header]);
            }
        }
        // express.static's setHeaders, under a name only the middleware writes
        if (options._setHeaders) {
            options._setHeaders(this, fullpath, stat);
        }

        // from the stat, never from the app's "etag fn", as send computes it
        if (options.etag && !this.headers["etag"]) {
            this.headers["etag"] = statTag(stat, true);
        }

        // before the conditional checks, as send orders it: a 412 or a 416 still carries it
        if (options.acceptRanges) {
            this.headers["accept-ranges"] = "bytes";
        }

        // conditional requests
        if (isPreconditionFailure(this.req, this)) {
            return done(httpError(412));
        }

        // before range handling, as send orders it: fresh with an unsatisfiable Range is a 304
        if (this.req.fresh) {
            delete this.headers["content-type"];
            delete this.headers["content-encoding"];
            delete this.headers["content-language"];
            delete this.headers["content-length"];
            this.status(304);
            this.end();
            // never done(): on success that would be next()
            if (callback) callback();
            return;
        }

        // the start and end options first: send serves ranges relative to the window they select
        let offset = options.start || 0;
        let len = Math.max(0, stat.size - offset);
        if (options.end !== undefined) {
            const bytes = options.end - offset + 1;
            if (len > bytes) len = bytes;
        }

        // range requests
        if (options.acceptRanges) {
            // only the bytes unit, checked on the text as send does: "Bytes=0-1" is the whole file
            const rangeHeader = this.req.headers.range;
            if (rangeHeader !== undefined && BYTES_RANGE.test(rangeHeader)) {
                let ranges = /** @type {ReturnType<typeof import("range-parser")>} */ (
                    this.req.range(len, { combine: true })
                );

                // if-range
                if (!isRangeFresh(this.req, this)) {
                    ranges = -2;
                }

                if (ranges === -1) {
                    // on the error too: the error page writes back only what the error carries
                    const unsatisfiable = `bytes */${len}`;
                    this.headers["content-range"] = unsatisfiable;
                    const err = httpError(416);
                    err.headers = { "Content-Range": unsatisfiable };
                    return done(err);
                }
                if (ranges !== -2 && ranges.length === 1) {
                    this.status(206);
                    const range = ranges[0];
                    this.headers["content-range"] = `bytes ${range.start}-${range.end}/${len}`;
                    offset += range.start;
                    len = range.end - range.start + 1;
                }
            }
        }

        // only this file goes out without an etag: the error exits above compute their own, and
        // suppressing it before them made a 416 answer without one
        if (!options.etag) {
            this.req.noEtag = true;
        }

        const partial = offset > 0 || len < stat.size;

        if (this.req.method === "HEAD") {
            // len, not stat.size: a ranged HEAD answers the length of the part
            this.set("Content-Length", String(len));
            this.end();
            if (callback) callback();
            return;
        }

        // small files through the worker threads
        if (this.app.workers.length && stat.size < 768 * 1024 && !partial) {
            this.app
                .readSmallFile(fullpath, stat)
                .then((data) => {
                    if (this.finished || this.aborted) {
                        // ECONNABORTED goes to a callback and never to next(), as Express reports it
                        if (this.aborted && callback) {
                            /** @type {NodeJS.ErrnoException} */
                            const err = new Error("Request aborted");
                            err.code = "ECONNABORTED";
                            callback(err);
                        }
                        return;
                    }
                    this.end(data);
                    if (callback) callback();
                })
                .catch((err) => {
                    // the worker posts only the message: the fs code is read back out of it
                    const code = /\b(E[A-Z]+)\b/.exec(err.message);
                    if (code && !err.code) err.code = code[1];
                    done(asStatError(err));
                });
        } else {
            // large files and ranges are piped
            /** @type {{highWaterMark: number, start?: number, end?: number}} */
            const opts = {
                highWaterMark: HIGH_WATERMARK
            };
            if (partial) {
                opts.start = offset;
                opts.end = Math.max(offset, offset + len - 1);
            }
            const file = fs.createReadStream(fullpath, opts);
            this.set("Content-Length", String(len));
            // pipe() forwards no error from the source
            file.on("error", (err) => {
                file.destroy();
                if (!this.headersSent) return done(asStatError(err));
                this.destroy(err);
                if (callback) callback(err);
            });
            // a client abort never reaches the source either, and the fd stayed open
            const socket = this.socket;
            const cleanup = () => file.destroy();
            this.once("close", cleanup);
            socket?.once("close", cleanup);
            file.once("close", () => {
                this.removeListener("close", cleanup);
                socket?.removeListener("close", cleanup);
            });
            // "end" fires on a full read only, never with "error"
            if (callback) {
                file.once("end", () => callback());
            }
            file.pipe(this);
        }
    }

    /**
     * Sends a file as an attachment. `filename` and `options` can both be left out, a function in
     * either position is the callback.
     *
     * @param {string} path
     * @param {string} [filename] name offered to the user, defaults to the basename of the path
     * @param {import("./options").SendFileOptions} [options] passed through to sendFile
     * @param {(err?: Error) => void} [callback]
     */
    download(path, filename, options, callback) {
        let done = callback;
        /** @type {string|null|undefined} */
        let name = filename;
        let opts = options || null;

        if (typeof filename === "function") {
            done = /** @type {any} */ (filename);
            name = null;
            opts = null;
        } else if (typeof options === "function") {
            done = /** @type {any} */ (options);
            opts = null;
        }

        if (typeof filename === "object" && (typeof options === "function" || options === undefined)) {
            name = null;
            opts = filename;
        }

        // a header option of sendFile, as Express does: it only goes out once the stat succeeded
        /** @type {Record<string, string>} */
        const headers = {
            "Content-Disposition": contentDisposition(name || path)
        };

        // the caller's headers never override the disposition
        if (opts && opts.headers) {
            for (const key of Object.keys(opts.headers)) {
                if (key.toLowerCase() !== "content-disposition") {
                    headers[key] = opts.headers[key];
                }
            }
        }

        const merged = Object.create(opts ?? null);
        merged.headers = headers;

        // a relative path resolves against cwd, as Express resolves it
        const fullPath = !merged.root ? Path.resolve(path) : path;

        return this.sendFile(fullPath, merged, done);
    }

    /**
     * Sets a header node's way: no charset added to a content-type, that is res.set.
     *
     * @param {string} field
     * @param {number|string|readonly string[]|undefined} value an array sends the header once per
     *   entry; undefined is refused, as node refuses it
     * @returns {this}
     * @throws {Error} once the headers have gone out
     * @throws {TypeError} if the name is not a token, the value is undefined, or the value holds a
     *   character that cannot go on the wire
     */
    setHeader(field, value) {
        if (this.headersSent) {
            throw headersSentError("set");
        }
        // names are validated and lowercased once, middleware writes the same ones on every request
        let key = VALIDATED_HEADER_NAMES.get(field);
        if (key === undefined) {
            validateHeaderName(field);
            key = field.toLowerCase();
            if (VALIDATED_HEADER_NAMES.size < 512) {
                VALIDATED_HEADER_NAMES.set(field, key);
            }
        }
        if (value === undefined) {
            /** @type {NodeJS.ErrnoException} */
            const err = new TypeError(`Invalid value "undefined" for header "${field}"`);
            err.code = "ERR_HTTP_INVALID_HEADER_VALUE";
            throw err;
        }
        // as text, as node serialises them: a raw number would throw in uWS's writeHeader. Checked
        // before it is stored, a bad value in here throws on the flush with nobody left to catch it
        const out = Array.isArray(value) ? value.map(String) : String(value);
        validateHeaderValue(field, out);
        // node drops its Keep-Alive once the response set Connection itself, as every SSE library does
        if (key === "connection" && this.headers["keep-alive"] === SEEDED_KEEP_ALIVE) {
            delete (/** @type {Record<string, string|string[]>} */ (this.headers)["keep-alive"]);
        }
        this.headers[key] = out;
        return this;
    }

    /**
     * Throws away any header that could not be written: setHeader refuses them, but `res.headers`
     * is the live object. Only the error page calls it, where a throw out of the flush has nobody
     * left to catch it. Everything writable stays, a middleware's headers belong on the error too.
     *
     * @returns {void}
     */
    _dropUnwritableHeaders() {
        for (const header in this.headers) {
            if (!headerIsWritable(header, this.headers[header])) {
                delete this.headers[header];
            }
        }
    }

    /**
     * node's flushHeaders(), which `@angular/ssr` calls before streaming a page. **The head does
     * not reach the wire here:** uWS holds it until the first body chunk, and its `beginWrite`
     * emits a stray CRLF before the first chunk size (HPE_INVALID_CHUNK_SIZE in node, checked on
     * v20.69.0). A second call, a finished or an aborted response write nothing.
     *
     * @returns {void}
     */
    flushHeaders() {
        if (this.#headOut || this.finished || this.aborted) {
            return;
        }
        this._res.cork(() => {
            if (!this.headersSent) {
                this.writeHead(this.statusCode);
            }
            // a plain 200 is uWS's own head
            if (this.#status !== 200 || this.#statusText !== undefined) {
                this._res.writeStatus(statusLine(this.#status, this.#statusText));
            }
            this.writeHeaders(true);
        });
    }

    /**
     * node's `writeEarlyHints`. **Nothing is sent:** uWebSockets.js has no API for an informational
     * response, this only keeps Express code running. The callback is still called. `writeContinue`
     * and `writeProcessing` below are the same.
     *
     * @param {Record<string, string|string[]>} [hints]
     * @param {() => void} [callback]
     * @returns {void}
     */
    writeEarlyHints(hints, callback) {
        this.#refuseInformationAfterHead();
        if (typeof callback === "function") {
            process.nextTick(callback);
        }
    }

    /**
     * node's `writeContinue`, the `100` that answers an `Expect: 100-continue`. Nothing is sent:
     * see {@link Response#writeEarlyHints}.
     *
     * @returns {void}
     */
    writeContinue() {
        this.#refuseInformationAfterHead();
    }

    /**
     * node's `writeProcessing`, the `102`. Nothing is sent: see {@link Response#writeEarlyHints}.
     *
     * @returns {void}
     */
    writeProcessing() {
        this.#refuseInformationAfterHead();
    }

    /**
     * node throws from all three above once the head is out, and an application may rely on it.
     *
     * @returns {void}
     */
    #refuseInformationAfterHead() {
        if (this.headersSent) {
            throw headersSentError("write");
        }
    }

    /**
     * node's `addTrailers`. µWebSockets.js cannot send them, so nothing is written.
     *
     * @param {Record<string, string>|[string, string][]} [headers]
     * @returns {void}
     */
    addTrailers(headers) {}

    /**
     * node's per-response socket timeout, which cannot change µWS's own `uwsOptions.idleTimeout`.
     * The callback is registered on "timeout" as node's does, and nothing emits it.
     *
     * @param {number} msecs
     * @param {() => void} [callback]
     * @returns {this}
     */
    setTimeout(msecs, callback) {
        if (typeof callback === "function") {
            this.once("timeout", callback);
        }
        return this;
    }

    /**
     * node's `assignSocket`. There is no raw socket here.
     *
     * @param {import("net").Socket} [socket]
     * @returns {void}
     */
    assignSocket(socket) {}

    /**
     * node's `detachSocket`. There is no raw socket here.
     * @param {import("net").Socket} [socket]
     * @returns {void}
     */
    detachSocket(socket) {}

    /**
     * node's name for `statusText`.
     *
     * @returns {string|undefined}
     */
    get statusMessage() {
        return this.statusText;
    }

    set statusMessage(value) {
        this.statusText = value;
    }

    /**
     * node's `hasHeader`, case insensitive.
     *
     * @param {string} name
     * @returns {boolean}
     */
    hasHeader(name) {
        return this.headers[name.toLowerCase()] !== undefined;
    }

    /**
     * node's `getHeaderNames`, lowercased.
     *
     * @returns {string[]}
     */
    getHeaderNames() {
        return Object.keys(this.headers);
    }

    /**
     * node's `getRawHeaderNames`. Names are held lowercased here, so the same as getHeaderNames.
     *
     * @returns {string[]}
     */
    getRawHeaderNames() {
        return Object.keys(this.headers);
    }

    /**
     * node's `appendHeader`: a header with a value already becomes a list.
     *
     * @param {string} name
     * @param {string|readonly string[]} value
     * @returns {this}
     */
    appendHeader(name, value) {
        const key = name.toLowerCase();
        const current = this.headers[key];
        if (current === undefined) {
            return this.setHeader(name, value);
        }
        const merged = /** @type {string[]} */ ([]).concat(current, value);
        return this.setHeader(name, merged);
    }

    /**
     * node's `setHeaders`, from a Headers or a Map. set-cookie is read through getSetCookie, so
     * the values stay separate.
     *
     * @param {Headers|Map<string, string|readonly string[]>} headers
     * @returns {this}
     */
    setHeaders(headers) {
        if (typeof Headers === "function" && headers instanceof Headers) {
            for (const name of new Set([...headers.keys()])) {
                if (name === "set-cookie") {
                    this.setHeader(name, headers.getSetCookie());
                } else {
                    this.setHeader(name, /** @type {string} */ (headers.get(name)));
                }
            }
            return this;
        }
        for (const [name, value] of headers) {
            this.setHeader(name, value);
        }
        return this;
    }

    /** node asks this on its own header path before validating a value; true keeps it permissive. */
    _isLenientHeaderValidation() {
        return true;
    }

    /**
     * The other Express name for set().
     * @param {string|object} field a header name, or an object of them
     * @param {string|string[]} [value]
     * @returns {this}
     */
    header(field, value) {
        return this.set(field, value);
    }

    /**
     * Sets one header, or several from an object. Also available as `header()`.
     * @param {string|object} field header name, or an object of them
     * @param {string|string[]} [value]
     * @returns {this}
     */
    set(field, value) {
        if (typeof field === "object") {
            const fields = /** @type {Record<string, string|string[]>} */ (field);
            for (const header in fields) {
                this.set(header, fields[header]);
            }
        } else {
            const name = field.toLowerCase();
            // coerced here as Express does, so res.get answers what was sent
            let out = Array.isArray(value) ? value.map(String) : String(value);
            if (name === "content-type") {
                if (Array.isArray(out)) {
                    throw new TypeError("Content-Type cannot be set to an Array");
                }
                const resolved = contentTypeSet(out);
                if (resolved === false) {
                    // an unknown extension is stored as the false express stores, so send() and
                    // json() read it as unset. setHeader first, for the checks
                    this.setHeader(field, "false");
                    this.headers[name] = /** @type {any} */ (false);
                    return this;
                }
                out = resolved;
            }
            // the name as written: a refused header is reported by it, as Express reports it
            this.setHeader(field, out);
        }
        return this;
    }

    /**
     * Reads a response header that has been set, case insensitively.
     * @param {string} field
     * @returns {string|string[]|undefined}
     */
    get(field) {
        const name = field.toLowerCase();
        const value = this.headers[name];
        // Content-Length is uWS's, measured from the body it was handed: worked out here only for
        // whoever asks, morgan's common and combined formats do, and kept
        if (value === undefined && name === "content-length" && this._sentBody !== undefined) {
            const length = Buffer.byteLength(this._sentBody);
            this.headers["content-length"] = String(length);
            return String(length);
        }
        return value;
    }

    /**
     * node's name for get().
     * @param {string} field
     * @returns {string|string[]|undefined}
     */
    getHeader(field) {
        return this.get(field);
    }

    /**
     * Every header set so far, a shallow copy on a null prototype as node answers: a write into the
     * live object reached the wire without setHeader's validation, see issue #6.
     * @returns {Record<string, any>}
     */
    getHeaders() {
        return Object.assign({ __proto__: null }, this.headers);
    }

    /**
     * Removes a header not flushed yet. Returns nothing, as node's does.
     *
     * @param {string} field
     */
    removeHeader(field) {
        if (this.headersSent) {
            throw headersSentError("remove");
        }
        const key = field.toLowerCase();
        // helmet removes a header most responses never carry, and a delete is a runtime call
        if (key in this.headers) {
            delete this.headers[key];
        }
    }

    /**
     * Adds a header without replacing what is there, for Set-Cookie and Vary.
     * @param {string} field
     * @param {string|string[]} value
     * @returns {this}
     */
    append(field, value) {
        // merged then through set(), as Express does
        const prev = this.get(field);
        let merged = value;
        if (prev) {
            merged = Array.isArray(prev)
                ? prev.concat(value)
                : Array.isArray(value)
                  ? [prev].concat(value)
                  : [prev, value];
        }
        return this.set(field, merged);
    }

    /**
     * Renders a view and sends it, or hands it to the callback and sends nothing.
     * @param {string} view view name
     * @param {Record<string, any>|((err: Error|null, html?: string) => void)} [options] locals for the
     *   view, or the callback in its place
     * @param {(err: Error|null, html?: string) => void} [callback]
     */
    render(view, options, callback) {
        if (typeof options === "function") {
            callback = /** @type {(err: Error|null, html?: string) => void} */ (options);
            options = {};
        }
        if (!options) {
            options = {};
        } else {
            options = Object.assign({}, options);
        }
        options._locals = this.locals;
        const done =
            callback ||
            ((err, str) => {
                // the router's next, as sendFile: the rest of the route is skipped
                if (err) return (this.req._leaveRoute ?? this.req.next)(err);
                this.send(str);
            });

        // req.app, as express: a mounted sub-app resolves views with its own settings
        this.req.app.render(view, options, done);
    }

    /**
     * Appends a Set-Cookie. An object value is JSON, `signed` uses cookie-parser's secret.
     * @param {string} name
     * @param {string|object} value
     * @param {{maxAge?: number, expires?: Date, path?: string, domain?: string, secure?: boolean,
     *   httpOnly?: boolean, sameSite?: boolean|"lax"|"strict"|"none", signed?: boolean,
     *   priority?: "low"|"medium"|"high", partitioned?: boolean}} [options]
     * @returns {this}
     */
    cookie(name, value, options) {
        // a copy, the options are changed below (ultimate-express#68)
        const opt = { ...(options ?? {}) };
        // cookie-parser hangs the secret on the request
        const req = /** @type {{secret?: string}} */ (this.req);
        if (opt.signed && !req.secret) {
            throw new Error('cookieParser("secret") required for signed cookies');
        }
        let val = typeof value === "object" ? "j:" + JSON.stringify(value) : String(value);
        if (opt.maxAge != null) {
            const maxAge = opt.maxAge - 0;
            if (!isNaN(maxAge)) {
                opt.expires = new Date(Date.now() + maxAge);
                opt.maxAge = Math.floor(maxAge / 1000);
            }
        } else {
            // our cookie package refuses a null maxAge, Express's ignores it
            delete opt.maxAge;
        }
        if (opt.signed) {
            val = "s:" + sign(val, /** @type {string} */ (req.secret));
        }

        if (opt.path == null) {
            opt.path = "/";
        }

        this.append("Set-Cookie", cookie.serialize(name, val, opt));
        return this;
    }

    /**
     * Clears a cookie: expires it now, whatever `maxAge` or `expires` say. The browser matches it
     * only with the `path` and `domain` it was set with.
     * @param {string} name
     * @param {Record<string, any>} [options]
     * @returns {this}
     */
    clearCookie(name, options) {
        /** @type {Record<string, any>} */
        const opts = { path: "/", ...options, expires: new Date(1) };
        delete opts.maxAge;
        return this.cookie(name, "", opts);
    }

    /**
     * Content-Disposition: attachment, and the Content-Type of the filename's extension.
     * @param {string} [filename]
     * @returns {this}
     */
    attachment(filename) {
        if (filename) {
            this.type(Path.extname(filename));
        }
        this.set("Content-Disposition", contentDisposition(filename));
        return this;
    }

    /**
     * Calls the handler whose key the Accept header matches best, `default` otherwise, 406 with
     * none. Sets Vary: Accept.
     * @param {Record<string, Function>} object handlers keyed by extension or mime type
     * @returns {this}
     */
    format(object) {
        const keys = Object.keys(object).filter((v) => v !== "default");
        const key = keys.length > 0 ? /** @type {string|false} */ (this.req.accepts(keys)) : false;

        this.vary("Accept");

        // the router next, as express: a 406 leaves the route, see Walk#runRoute
        const next = this.req._leaveRoute ?? this.req.next;
        if (key) {
            this.set("Content-Type", normalizeType(key).value);
            object[key](this.req, this, next);
        } else if (object.default) {
            object.default(this.req, this, next);
        } else {
            // an error carrying the types it could have sent, as express
            const err = httpError(406);
            err.types = keys.map((type) => normalizeType(type).value);
            next(err);
        }

        return this;
    }

    /**
     * Sends JSON, honouring the "json replacer", "json spaces" and "json escape" settings.
     * @param {*} body
     * @returns {this}
     */
    json(body) {
        const hot = this.app._hot();
        // serialised before the type is set, as express: a BigInt throws with the headers untouched
        const json = stringify(body, hot.jsonReplacer, hot.jsonSpaces, hot.jsonEscape);
        if (!this.headers["content-type"]) {
            // express sets it through res.set, which refuses once the head is out: json(undefined)
            // after a writeHead has to throw here, since send() lets an undefined body through
            if (this.headersSent) {
                throw headersSentError("set");
            }
            this.headers["content-type"] = JSON_UTF8;
        }
        return this.send(json);
    }

    /**
     * JSON wrapped in the callback the query names ("jsonp callback name", default "callback"),
     * plain JSON without one.
     * @param {*} object
     * @returns {this}
     */
    jsonp(object) {
        let callback = this.req.query[this.app.get("jsonp callback name")];
        let body = stringify(
            object,
            this.app.get("json replacer"),
            this.app.get("json spaces"),
            this.app.get("json escape")
        );
        let js = false;

        if (Array.isArray(callback)) {
            callback = callback[0];
        }

        if (typeof callback === "string" && callback.length !== 0) {
            callback = callback.replace(/[^[\]\w$.]/g, "");

            if (body === undefined) {
                body = "";
            } else if (typeof body === "string") {
                // the two characters JSON allows and JavaScript does not
                body = body.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
            }
            body = "/**/ typeof " + callback + " === 'function' && " + callback + "(" + body + ");";
            js = true;
        }

        // as in json() above: express sets these through res.set, which refuses after the head
        if (this.headersSent && (!this.headers["content-type"] || js)) {
            throw headersSentError("set");
        }
        if (!this.headers["content-type"]) {
            this.headers["x-content-type-options"] = "nosniff";
            this.headers["content-type"] = "application/json; charset=utf-8";
        }
        if (js) {
            // with a callback the body is script whatever type was set before
            this.headers["x-content-type-options"] = "nosniff";
            this.headers["content-type"] = "text/javascript; charset=utf-8";
        }

        return this.send(body);
    }

    /**
     * Adds to the Link header, one entry per rel.
     * @param {Record<string, string>} links rel to url
     * @returns {this}
     */
    links(links) {
        let link = this.get("Link") || "";
        if (link) link += ", ";
        return this.set(
            "Link",
            link +
                Object.keys(links)
                    .map(function (rel) {
                        const target = links[rel];
                        // an array is several links sharing a rel, one entry each
                        if (Array.isArray(target)) {
                            return target.map((one) => "<" + one + '>; rel="' + rel + '"').join(", ");
                        }
                        return "<" + target + '>; rel="' + rel + '"';
                    })
                    .join(", ")
        );
    }

    /**
     * Sets the Location header, URL-encoded. "back" is a literal location, Express 5 dropped the
     * Referrer shortcut.
     *
     * @param {string} path
     * @returns {this}
     */
    location(path) {
        this.headers["location"] = encodeUrl(path);
        return this;
    }

    /**
     * Redirects, 302 by default or `redirect(301, url)`, with a short body in the format the
     * client accepts.
     * @param {number|string} status status code, or the url when the status is left out
     * @param {string} [url]
     * @param {boolean} [forceHtml] answer with an HTML body whatever the client accepts
     */
    redirect(status, url, forceHtml = false) {
        if (typeof status !== "number" && !url) {
            url = status;
            status = 302;
        }
        // read from the closures below too, where the checker does not see the shuffle above
        const code = /** @type {number} */ (status);
        this.location(/** @type {string} */ (url));
        this.status(code);

        const address = /** @type {string} */ (this.get("Location"));
        let body;
        if (forceHtml) {
            // uppercase charset, as the redirect send and serve-static emit; format() below takes
            // the lowercase form from the mime lookup
            this.set("Content-Type", "text/html; charset=UTF-8");
            body =
                "<!DOCTYPE html>\n" +
                '<html lang="en">\n' +
                "<head>\n" +
                '<meta charset="utf-8">\n' +
                "<title>Redirecting</title>\n" +
                "</head>\n" +
                "<body>\n" +
                `<pre>Redirecting to ${escapeHtml(address)}</pre>\n` +
                "</body>\n" +
                "</html>\n";
        } else {
            this.format({
                text: () => {
                    this.set("Content-Type", "text/plain; charset=utf-8");
                    body = `${statuses.message[code]}. Redirecting to ${address}`;
                },
                html: () => {
                    this.set("Content-Type", "text/html; charset=utf-8");
                    body = `<p>${statuses.message[code]}. Redirecting to ${escapeHtml(address)}</p>`;
                },
                default: () => {
                    // no Content-Type, as Express leaves it when the client accepts neither
                    body = "";
                }
            });
        }
        // before the HEAD check, as Express: a HEAD answers the GET body's length
        this.set("Content-Length", String(Buffer.byteLength(body ?? "")));
        if (this.req.method === "HEAD") {
            this.end();
        } else {
            this.end(body);
        }
    }

    /**
     * Sets Content-Type from an extension (octet-stream when unknown, unlike res.set) or a type
     * with a slash as written. Also `contentType()`.
     * @param {string} type
     * @returns {this}
     */
    type(type) {
        const ct = type.indexOf("/") === -1 ? contentTypeFor(type) : type;
        return this.set("Content-Type", ct);
    }

    /**
     * Adds a field to Vary, without repeating one already there.
     * @param {string|string[]} field
     * @returns {this}
     * @throws {TypeError} with no field at all; an empty list does nothing, as the vary package decides
     */
    vary(field) {
        vary(/** @type {import("http").ServerResponse} */ (/** @type {unknown} */ (this)), field);
        return this;
    }

    /** The same object as socket, which node carries under both names. */
    get connection() {
        return this.socket;
    }

    /**
     * Writable's plain property, replaced by a getter over our own flag since its machinery is
     * bypassed here. The directive sits outside this block or it reads as a JSDoc tag.
     */
    // @ts-expect-error TS2611, the accessor replacing the base property is deliberate
    get writableFinished() {
        return this.finished;
    }

    /**
     * The same moment as writableFinished here, end() hands the whole response to uWS. The base
     * property answered false forever, and LibreChat's agent stream kept writing to a dead response.
     */
    // @ts-expect-error TS2611, the accessor replacing the base property is deliberate
    get writableEnded() {
        return this.finished;
    }
};

// express's other name for res.type, on the prototype so no own property is written per response
/** @type {{contentType?: typeof module.exports.prototype.type}} */ (module.exports.prototype).contentType =
    module.exports.prototype.type;
