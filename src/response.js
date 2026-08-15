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
    withDefaultCharset,
    withUtf8Charset,
    asStatError,
    httpError,
    contentTypeFor,
    statTag,
    cachedStat,
    NullObject
} = require("./utils.js");
const { Writable } = require("stream");
const { isAbsolute } = require("path");
const fs = require("fs");
const Path = require("path");
const statuses = require("statuses");
const { sign } = require("cookie-signature");
// events is faster at init, tseep is faster at sending events
// since we create a ton of objects and dont send a ton of events, its better to use events here
const { EventEmitter } = require("events");
const http = require("http");
const ms = require("ms");

// How much a chunked response may gather before it is handed to uWS. Measured on uWS alone with
// 33 KB written in 500 pieces: 16.2ms handed over one piece at a time, 0.79ms in 4 KB blocks,
// 0.43ms in 8 KB, 0.45ms in 16 KB. Past 8 KB the curve is flat, so this is the smallest size that
// buys the whole saving, and it bounds what one response can hold back.
const COALESCE_LIMIT = 16 * 1024;

// Below which a chunk is worth gathering. Merging costs a copy, and a chunk that is already
// substantial does not earn it back: measured at 33 KB in eight pieces, gathering them made the
// response 28% dearer, while the same bytes in sixty-six pieces got 3.4x cheaper. Anything from
// here up goes straight through.
const COALESCE_BELOW = 4 * 1024;

const outgoingMessage = new http.OutgoingMessage();
const symbols = Object.getOwnPropertySymbols(outgoingMessage);
// if a future node renames it, fall back to a private symbol rather than writing a property
// literally named "undefined", which is what indexing with undefined would do
const kOutHeaders = symbols.find((s) => s.toString() === "Symbol(kOutHeaders)") ?? Symbol("kOutHeaders");
const HIGH_WATERMARK = 128 * 1024;
// Statuses whose message carries no body, so no Content-Length may describe one either. 1xx is
// the third case and is checked by range rather than listed.
const STATUSES_WITHOUT_BODY = new Set([204, 304]);
// send's ceiling for maxAge, one year in milliseconds. Anything larger is clamped to it rather
// than written out, since a year is already longer than any cache will honour.
const MAX_MAXAGE = 60 * 60 * 24 * 365 * 1000;

class Socket extends EventEmitter {
    /**
     * Enough of a node socket for the middleware that reaches for one. There is no socket object
     * in uWS to hand over, so this stands in and forwards what it can to the response.
     *
     * @param {any} response
     */
    constructor(response) {
        super();
        this.response = response;

        this.on("error", (err) => {
            this.emit("close");
        });
    }

    /** Whether anything more can be written, which stops being true once the response is done. */
    get writable() {
        return !this.response.finished;
    }

    /**
     * Finishes the response through the socket, which is how the middleware that only knows
     * about sockets ends one.
     * @param {any} [body]
     */
    end(body) {
        this.response.end(body);
    }

    /** Closes the connection outright, without finishing a response first. */
    close() {
        if (this.response.finished) {
            return;
        }
        this.response.finished = true;
        this.emit("close");
        this.response._res.close();
    }
}

// One status line per code, built on first use: the default path, with no custom reason phrase,
// paid a template string and a trim per request for a line that never changes. Bounded to real
// HTTP codes so a wild writeHead value cannot grow the array or flip it into dictionary mode.
const STATUS_LINES = [];
/**
 * @param {number} code
 * @param {string|undefined} text an explicit reason phrase, which bypasses the cache
 * @returns {string} the uWS status line, e.g. "200 OK"
 */
function statusLine(code, text) {
    if (text === undefined && Number.isInteger(code) && code >= 100 && code <= 999) {
        return STATUS_LINES[code] ?? (STATUS_LINES[code] = code + " " + (statuses.message[code] ?? "unknown"));
    }
    return `${code} ${text ?? statuses.message[code] ?? "unknown"}`.trim();
}

/**
 * A Writable that has not built its state yet, the mirror of LazyReadable in request.js and there
 * for the same reason: a response is a Writable because middleware expects one, and the ordinary
 * one never uses it. `send()` reaches `end()`, which is overridden here and goes straight to
 * _finish, so the WritableState is allocated for every response and read by nobody. It is needed
 * only by res.write(), by a stream piped into the response, by cork and by the writableX getters.
 *
 * `Response extends LazyWritable`, whose prototype is Writable's, so `res instanceof Writable`
 * stays true and every Writable method is reachable; what is missing is `_writableState`, built on
 * the first touch. Measured at 45 nanoseconds a response on the machine this was written on.
 *
 * As on the Readable side the wrapping is generated rather than written out: every own member of
 * Writable's prototype gets a version that materialises first, so there is no list to keep in step.
 * Missing one would not be a slow path, it would be a TypeError on `undefined._writableState`.
 */
class LazyWritableBase {}
Object.setPrototypeOf(LazyWritableBase.prototype, Writable.prototype);
Object.setPrototypeOf(LazyWritableBase, Writable);

// what the chain says at runtime, said again for the type checker, which cannot see a prototype
// being reassigned
const LazyWritable = /** @type {typeof Writable} */ (/** @type {unknown} */ (LazyWritableBase));

/**
 * Builds the stream this object has been pretending to be. Idempotent: everything reachable from
 * outside goes through it, so it is called far more often than it does anything.
 *
 * EventEmitter's init keeps an _events that is already there, so both the shape the constructor
 * wrote and any listener added before this survive it.
 *
 * @param {any} stream
 */
function materialiseWritable(stream) {
    if (stream._writableState === undefined) {
        Writable.call(stream);
    }
}

for (const member of [
    ...Object.getOwnPropertyNames(Writable.prototype),
    ...Object.getOwnPropertySymbols(Writable.prototype)
]) {
    if (member === "constructor") {
        continue;
    }
    const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(Writable.prototype, member));
    if (typeof descriptor.value === "function") {
        const inner = descriptor.value;
        Object.defineProperty(LazyWritableBase.prototype, member, {
            ...descriptor,
            /** @this {any} @param {...any} args */
            value: function (...args) {
                materialiseWritable(this);
                return inner.apply(this, args);
            }
        });
    } else if (descriptor.get || descriptor.set) {
        const innerGet = descriptor.get;
        const innerSet = descriptor.set;
        Object.defineProperty(LazyWritableBase.prototype, member, {
            ...descriptor,
            get: innerGet
                ? /** @this {any} */ function () {
                      materialiseWritable(this);
                      return innerGet.call(this);
                  }
                : undefined,
            set: innerSet
                ? /** @this {any} @param {any} value */ function (value) {
                      materialiseWritable(this);
                      innerSet.call(this, value);
                  }
                : undefined
        });
    }
}

module.exports = class Response extends LazyWritable {
    /** @type {Socket|null} */
    #socket = null;

    /** Whether end() has run, which is what makes a second one a no-op rather than a throw. */
    #ended = false;

    /** @type {((err?: Error|null) => void)|null} */
    #pendingCallback = null;

    /**
     * Chunks written but not yet handed to uWS, and their total size.
     *
     * uWS charges for a write against everything already buffered behind it, so a chunked response
     * written in many small pieces costs quadratically once it passes the socket's own buffer:
     * measured on uWS alone, 500 writes of 66 bytes take 13ms against 0.06ms for 100 of them.
     * Handing it the same bytes in blocks costs 0.4ms. Nothing here changes what goes on the wire,
     * only how many calls it takes to put it there.
     * Null until the first chunked write, since a res.send never queues anything.
     * @type {Buffer[]|null}
     */
    #queued = null;

    /** How many bytes {@link #queued} holds, kept alongside so the flush does not add them up. */
    #queuedBytes = 0;

    /** Whether a flush is already booked for the end of this turn. */
    #flushBooked = false;

    /** @type {any} */
    #outHeaders = null;

    /**
     * The request this response answers, linked so either reaches the other.
     * @type {InstanceType<typeof import("./request.js")>}
     */
    req;

    /**
     * Built for every request, right after the Request it belongs to. The headers start with the
     * two that describe the connection, since every response carries them, and x-powered-by only
     * when the setting asks for it.
     *
     * @param {any} res the uWS response
     * @param {any} req the Request, already built, which is where the connection header is read from
     * @param {any} app the application or router this request arrived at
     */
    constructor(res, req, app) {
        super();
        // the EventEmitter half stays eager, since the stream half is what LazyWritable defers and
        // the two listeners below are written straight into this map. These are the five keys and
        // the order node's own Writable constructor lays down, so the hidden class is the one every
        // other stream in the process has, and node's init keeps this object when the state is
        // finally built
        this._events = {
            close: undefined,
            error: undefined,
            prefinish: undefined,
            finish: undefined,
            drain: undefined
        };
        this._eventsCount = 0;
        this._req = req;
        // linked here rather than by the caller: the pair is built together, and a field the
        // constructor leaves unset is a shape change on whoever assigns it first
        this.req = req;
        this._res = res;
        this.headersSent = false;
        this.app = app;
        this.locals = new NullObject();
        this.finished = false;
        this.aborted = false;
        this.statusCode = 200;
        this.statusText = undefined;
        this.chunkedTransfer = true;
        this.totalSize = 0;
        this.writingChunk = false;
        // timeout=10 is uWS's idle timeout. On the node shim the hosting server enforces its own
        // keepAliveTimeout, so node is left to write the truthful Connection and Keep-Alive itself.
        // "connection headers" off advertises neither, which Express always does: see below for
        // the one this still writes.
        this.headers =
            res._nodeRes || app.settings["connection headers"] === false
                ? {}
                : {
                      connection: "keep-alive",
                      "keep-alive": "timeout=10"
                  };
        // the client asked for the connection to be closed, and uWS closes it, so saying otherwise
        // would be telling the client something the transport contradicts. A declarative response
        // cannot do this, being written once and not per request.
        if (req._connectionClose) {
            this.headers.connection = "close";
        }
        if (app._hot().xPoweredBy) {
            this.headers["x-powered-by"] = "Fulmine";
        }

        this.body = undefined;
        // what was handed to uWS, kept so a caller asking for content-length after the fact can be
        // answered, see get(). Undefined until the response ends, and for one that sends no body
        /** @type {string|Buffer|undefined} */
        this._sentBody = undefined;
        // false while the uWS route handler is still in its synchronous window, where uWS holds
        // the socket corked itself; the two uWS entry points flip it once that window closes
        this._corkNeeded = false;
        // shared methods, not arrows: two closures and a once() wrapper here were four
        // allocations per request. EventEmitter calls listeners with this = the emitter.
        //
        // Written into the map rather than through on(). A stream arrives with its _events already
        // shaped, "close" and "error" among the keys and every value undefined, so filling two of
        // them is the same hidden class on() would have produced and none of its work: the argument
        // check, the newListener emission, the is-there-one-already branch and the max listener
        // count. Two calls per response, and the profile put them at 6% of a hello-world.
        //
        // The condition is the whole safety of it: a fresh response has no listeners, so both slots
        // are free, and anything else falls back to on(). Adding one later goes through on() as
        // usual and finds what this wrote, because this wrote what on() writes.
        // cast because _events and _eventsCount are EventEmitter's own bookkeeping and carry no
        // type: they are what on() writes, and this writes the same two entries
        const self = /** @type {any} */ (this);
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
    }

    /**
     * on(), not once(), so this must stay idempotent: end() emits 'close' by hand and a later
     * destroy() makes Writable emit it again.
     */
    _onCloseCleanup() {
        this.#ended = true;
        this._unlinkPending();
    }

    /**
     * Takes this response out of its app's pending list, which the graceful close() drains. The
     * list head lives in a holder on the per-app response prototype layer, see the Application
     * constructor; the linked flag makes a second call, from the drain or a late 'close', a no-op.
     */
    _unlinkPending() {
        if (this._pendingLinked !== true) {
            return;
        }
        this._pendingLinked = false;
        const pending = /** @type {any} */ (this)._pendingIn;
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
     * Where node keeps the outgoing headers of an OutgoingMessage. Only code going through node's
     * own header path ever looks, cookie-session being the one in this project's tests, so the
     * proxy standing in for it is built on the first look rather than on every response: it was a
     * proxy, a handler object and two closures each time, for something almost nothing reads.
     *
     * A setter as well, because node assigns to this slot when it resets the headers, and a getter
     * on its own would make that throw.
     */
    get [kOutHeaders]() {
        if (!this.#outHeaders) {
            this.#outHeaders = new Proxy(this.headers, {
                set: (obj, prop, value) => {
                    this.set(prop, value[1]);
                    return true;
                },
                get: (obj, prop) => {
                    return obj[prop];
                }
            });
        }
        return this.#outHeaders;
    }

    set [kOutHeaders](value) {
        this.#outHeaders = value;
    }

    /**
     * A socket-shaped object for middleware that reaches for one, built on first ask and kept
     * from then on. null once the response is over, as node reports it.
     * @returns {Socket|null}
     */
    get socket() {
        if (this.#ended) return null;
        if (!this.#socket) {
            this.#socket = new Socket(this);
        }
        return this.#socket;
    }

    /**
     * Hands everything queued to uWS as one write, which is where the saving is, and keeps the
     * backpressure the single write used to do.
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
                return true;
            });
        } else {
            // nothing is waiting on this one: uWS drains it and the next write finds out
            this.writingChunk = false;
        }
    }

    /**
     * The booked flush. Static, so a response that never writes in pieces allocates nothing for it:
     * nextTick forwards the receiver as an argument.
     *
     * @param {any} res
     */
    static #flushOnTick(res) {
        res.#flushBooked = false;
        if (res.aborted || res.finished || res.#queuedBytes === 0) return;
        res._res.cork(() => res.#flushQueued(null));
    }

    /**
     * Writable's sink. Sends the headers if they have not gone yet, then hands the chunk to uWS,
     * either through the queue above for a chunked response or through tryEnd when a Content-Length
     * said how much there would be. Backpressure comes back as onWritable, which is what defers the
     * callback rather than dropping the chunk.
     *
     * @param {any} chunk
     * @param {BufferEncoding} encoding
     * @param {(err?: Error|null) => void} callback
     */
    _write(chunk, encoding, callback) {
        if (this.aborted) {
            /** @type {NodeJS.ErrnoException} */
            const err = new Error("Request aborted");
            err.code = "ECONNABORTED";
            return this.destroy(err);
        }
        if (this.finished) {
            const err = new Error("Response already finished");
            return this.destroy(err);
        }

        this.writingChunk = true;
        this._res.cork(() => {
            if (!this.headersSent) {
                this.writeHead(this.statusCode);
                // "unknown" and not the bare number: node writes that reason phrase for a code it
                // has no message for, so the raw status lines match. The default 200 with no
                // phrase is uWS's own head, byte for byte, so it is not written at all
                if (this.statusCode !== 200 || this.statusText !== undefined) {
                    this._res.writeStatus(statusLine(this.statusCode, this.statusText));
                }
                this.writeHeaders(typeof chunk === "string");
            }

            if (!Buffer.isBuffer(chunk) && !(chunk instanceof ArrayBuffer)) {
                // the Buffer view is enough, uWS reads its offset and length itself
                chunk = Buffer.from(chunk);
            }

            if (this.chunkedTransfer) {
                // Held back rather than written, and handed over in one piece at the end of this
                // turn or once it is big enough to be worth a call. A stream that writes once per
                // turn, an SSE feed for instance, still leaves on its own turn: the queue only ever
                // gathers what was written without yielding in between.
                (this.#queued ??= []).push(/** @type {Buffer} */ (chunk));
                this.#queuedBytes += /** @type {Buffer} */ (chunk).byteLength;
                // a chunk that is already big enough to be worth its own call leaves with whatever
                // was waiting in front of it, rather than paying for a copy it does not need
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
     * Sets the status and, optionally, a batch of headers, the way node does. The second argument
     * is either the status message or the headers, since node allows both shapes.
     *
     * Nothing is written here despite the name: the headers go out when the body does.
     *
     * @param {number} statusCode
     * @param {string|Record<string, any>} [statusMessage] the reason phrase, or the headers
     * @param {Record<string, any>} [headers]
     * @returns {this}
     */
    writeHead(statusCode, statusMessage, headers) {
        this.statusCode = statusCode;
        if (typeof statusMessage === "string") {
            this.statusText = statusMessage;
        }
        if (!headers) {
            if (!statusMessage) return this;
            // the two-argument shape, where what looked like a reason phrase is the headers. A
            // string reaching here was already taken as the phrase above and simply has no keys.
            headers = /** @type {Record<string, any>} */ (statusMessage);
        }
        for (const header in headers) {
            this.set(header, headers[header]);
        }
        return this;
    }

    /**
     * Writes every header set so far to uWS, which is the point of no return. Content-Length is
     * not one of them: uWS wants the length through tryEnd or endWithoutBody, so it is taken out
     * here and kept on totalSize, where it also turns chunked framing off.
     *
     * One writeHeader per header on purpose. Packing the whole head into a single writeStatus
     * works on the wire, and was measured slower: constant header strings cross the boundary
     * already flat, while the packed head is concatenated fresh per response, see issue #11.
     *
     * @param {boolean} utf8 unused, kept because node's equivalent takes it and the two callers
     *   differ on what they know about the body
     */
    writeHeaders(utf8) {
        // Keep-Alive describes a connection that is being kept alive, so node leaves it out once
        // the connection is closing. That happens both when the client asked and when something
        // else set the header on the way out, which is what a proxy passing an upstream response
        // through does.
        const headers = this.headers;
        const res = this._res;
        const connection = headers["connection"];
        // length before lowercasing: no string of another length can lowercase to "close", and
        // the value here is nearly always the 10-char "keep-alive", which paid a scan per response
        const closing =
            typeof connection === "string" && connection.length === 5 && connection.toLowerCase() === "close";
        // for..in over an object some responses delete from, which is the shape the request side
        // was taken off for #rawHeadersEntries. It stays here, and the difference is where the
        // deletes are: a 200 with a body performs none. Only 204, 304, 205, the freshness branch of
        // sendFile and removeHeader do, this object is built fresh per response, so a dictionary one
        // of them made costs that response and nothing after it. The request side deleted on every
        // request, which is what made it worth a different structure
        for (const header in headers) {
            if (closing && header === "keep-alive") {
                continue;
            }
            const value = headers[header];
            if (header === "content-length") {
                // if content-length is set, disable chunked transfer encoding, since size is known
                this.chunkedTransfer = false;
                this.totalSize = parseInt(value);
                continue;
            }
            if (Array.isArray(value)) {
                for (const val of value) {
                    res.writeHeader(header, val);
                }
            } else {
                res.writeHeader(header, value);
            }
        }
        this.headersSent = true;
    }

    /**
     * What node calls before writing a body when the caller never called writeHead. Here there is
     * nothing to flush, since the headers are written with the body, so this only fixes the status.
     */
    _implicitHeader() {
        // compatibility function
        // usually should send headers but this is useless for us
        this.writeHead(this.statusCode);
    }

    /**
     * Sets the status code.
     * @param {number} code an integer from 100 to 999
     * @returns {this} the response, for chaining
     * @throws {TypeError} if the code is not an integer, "200" included
     * @throws {RangeError} if it is an integer outside the range
     */
    status(code) {
        // Express 5 rejects anything that is not a plausible status code, instead of writing NaN or
        // a nonsense number into the response line, and it tells the two ways of being wrong apart:
        // the wrong type is a TypeError and the wrong number is a RangeError. Both messages are
        // Express's own, since they are what reaches whoever catches them
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
     * @param {any} [data]
     * @param {any} [cb]
     * @returns {this}
     */
    end(data, cb) {
        if (typeof data === "function") {
            cb = data;
            data = undefined;
        }
        if (typeof cb !== "function") {
            cb = undefined; // silence the error?
        }

        if (this.writingChunk) {
            this.once("drain", () => {
                this.end(data, cb);
            });
            return this;
        }
        if (this.finished) {
            return this;
        }
        this.writeHead(this.statusCode);
        // uWS holds the socket corked for the synchronous window of its route handler, and
        // cork inside cork is a passthrough: the wrapper and its closure are only paid once the
        // answer has outlived that window, which is what _corkNeeded records
        if (this._corkNeeded) {
            this._res.cork(() => this._finish(data, cb));
        } else {
            this._finish(data, cb);
        }
        return this;
    }

    /**
     * The corked tail of end(): status, headers, body and the finish events. Split out so a
     * synchronous answer calls it straight, already inside uWS's own cork.
     *
     * @param {any} data
     * @param {any} cb
     */
    _finish(data, cb) {
        // read before the head is written below, which is what sets the flag: what matters further
        // down is whether something had already committed the framing, a flushHeaders() or a first
        // res.write(), not whether this call is about to write the head itself
        const headWasAlreadyOut = this.headersSent;
        if (!this.headersSent) {
            // freshness is not decided here. node's end() knows nothing about conditional
            // requests, and Express answers 304 from send() and from sendFile(), each of
            // which strips the entity headers first. Deciding it here meant res.end("body")
            // answered 304 and dropped the body that the caller had just written.
            // "unknown" for a code without a message, as node's status line has it.
            // The default 200 with no phrase is not written at all: uWS emits the identical
            // "HTTP/1.1 200 OK" head on its own, and the crossing costs more than it says
            if (this.statusCode !== 200 || this.statusText !== undefined) {
                this._res.writeStatus(statusLine(this.statusCode, this.statusText));
            }
            this.writeHeaders(true);
        }
        const contentLength = this.headers["content-length"];
        if (STATUSES_WITHOUT_BODY.has(this.statusCode) || this.statusCode < 200) {
            // no body and no length describing one, whatever the caller passed. node decides
            // this the same way, from the status alone, so res.status(304).end("x") sends the
            // status and nothing else on either.
            this._res.endWithoutBody();
        } else if (!data && contentLength) {
            this._res.endWithoutBody(contentLength.toString());
        } else if (headWasAlreadyOut && this.chunkedTransfer) {
            // whatever is still queued goes first: end() must not overtake the body written before it
            this.#flushQueued(null);
            // The head has already gone out without a length, which is what flushHeaders() and the
            // first res.write() both do, so this response is committed to chunked framing and a
            // length can no longer describe it. node is committed the same way: after a flush,
            // res.end("body") sends a chunk, not a Content-Length. Handing the body to uWS's end()
            // here would have it append a length to a head that already said otherwise, which is
            // what the comparison test caught.
            if (data) {
                this._res.write(data);
                this._sentBody = data;
            }
            this._res.endWithoutBody();
        } else {
            // a Buffer goes to uWS as the view it is: copying it into a fresh ArrayBuffer was
            // an allocation per body, and uWS reads the view's own offset and length
            if (this.req.method === "HEAD") {
                const length = Buffer.byteLength(data ?? "");
                this.headers["content-length"] = String(length);
                this._res.endWithoutBody(length.toString());
            } else {
                // remembered rather than measured: only a caller that asks for content-length pays
                // for it, and uWS is measuring the same bytes for the wire anyway
                this._sentBody = data ?? "";
                // and null is sent as the empty body it means. uWS answers end(null) with a
                // response the client never sees the end of, where node and express send an empty
                // 200: res.end(null) is what the compression module's own test suite does
                this._res.end(data ?? "");
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
     * Sends the body, picking a Content-Type when none was set and adding an ETag when the
     * "etag" setting asks for one.
     *
     * A number is a value to serialise, the same as a boolean or an object, and never a status
     * code: use `sendStatus()` for that.
     *
     * @param {string|number|boolean|object|Buffer|null} [body]
     * @returns {this}
     */
    send(body) {
        if (this.headersSent) {
            throw new Error("Can't write body: Response was already sent");
        }
        // a typed array is bytes to send, not an object to serialise: res.send(new Uint8Array([104,
        // 101, 121])) is "hey" and not {"0":104,"1":101,"2":121}. Uint8Array and not every view
        // over an ArrayBuffer, because that is what node's own write accepts, and Express hands the
        // view straight to it: a DataView reaches node there and comes out as an empty body
        if (body instanceof Uint8Array && !Buffer.isBuffer(body)) {
            body = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
        }
        const isBuffer = Buffer.isBuffer(body);
        // undefined means nothing was passed, and Express treats that differently from a value
        // that happens to be empty: no content-type and no ETag for send(), both for send(null)
        // and send("").
        if (body === undefined) {
            return this.end("");
        }
        // null is an object as far as Express's switch is concerned, so it becomes the empty
        // string without ever reaching the branch that gives a string its content-type. It still
        // earns an ETag. send("") takes the string branch and does get one.
        let skipContentType = false;
        if (body === null) {
            body = "";
            skipContentType = true;
        } else if (typeof body === "object" && !isBuffer) {
            return this.json(body);
        } else if (typeof body === "number") {
            // a number is a value to serialise, the same as a boolean, and never a status code.
            // res.sendStatus() is what sets a status.
            return this.json(body);
        } else if (typeof body === "boolean") {
            return this.json(body);
        } else if (!isBuffer) {
            body = String(body);
        }
        if (typeof body === "string" && !isBuffer) {
            const contentType = this.headers["content-type"];
            if (!contentType) {
                // send(null) sends an empty string without choosing a type. Only a string argument
                // reaches for text/html, which is the branch Express's switch takes for it.
                if (!skipContentType) {
                    this.headers["content-type"] = "text/html; charset=utf-8";
                }
            } else if (typeof contentType === "string") {
                // replaced, not only added: the body goes out as utf-8, so a content-type saying
                // iso-8859-1 would be describing bytes that are not there.
                this.headers["content-type"] = withUtf8Charset(contentType);
            }
        } else {
            if (!this.headers["content-type"]) {
                this.headers["content-type"] = "application/octet-stream";
            }
        }
        // the ETag belongs here rather than in end(): node's end() does not produce one, so
        // res.end() and res.redirect() must not either. It has to be set before end() reads
        // req.fresh, which compares If-None-Match against it.
        // body is defined by the time it gets here, so an empty one still earns an ETag. Testing
        // its truthiness instead meant send("") and send(null) came back without one.
        // Every method by default, not only GET and HEAD: gating it looked safe, freshness being
        // defined over those two alone, and express's own suite failed on it, "should send ETag
        // in response to <METHOD> request" exists per method. The "etag methods" setting is that
        // gate as an opt-in, see issue #10.
        const hot = this.app._hot();
        const etagFn = hot.etagFn;
        if (
            etagFn &&
            !this.headers["etag"] &&
            !this.req.noEtag &&
            (hot.etagMethods === null || hot.etagMethods.has(this.req.method))
        ) {
            const etag = etagFn(body);
            // an application's own etag function is allowed to decline: returning nothing means no
            // header, rather than a header saying "undefined"
            if (etag) {
                this.headers["etag"] = etag;
            }
        }
        // after the ETag, never before: freshness compares If-None-Match against the one that is
        // about to be sent, so a generated ETag has to exist by now.
        if (this.req.fresh) {
            this.status(304);
        }
        // A 204 and a 304 carry no body, so the headers describing one have no meaning and are
        // dropped. A 205 carries no body either but has to say so with an explicit length.
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
        return this.end(body);
    }

    /**
     * Streams a file, setting Content-Type from the extension and answering conditional and range
     * requests. The path must be absolute unless `options.root` is given, and a function in the
     * options position is the callback.
     *
     * Options: `root`, `maxAge`, `lastModified`, `headers`, `dotfiles` ("allow", "deny" or
     * "ignore"), `acceptRanges`, `cacheControl`, `immutable`, `etag` and `setHeaders`.
     *
     * @param {string} path
     * @param {import("./options").SendFileOptions} [options]
     * @param {(err?: Error) => void} [callback] called once sent, or with the error
     */
    sendFile(path, options = new NullObject(), callback) {
        if (!path) {
            throw new TypeError("path argument is required to res.sendFile");
        }
        // a separate message from the one above, as Express has: "required" is wrong for an
        // argument that was passed and was a number
        if (typeof path !== "string") {
            throw new TypeError("path must be a string to res.sendFile");
        }
        if (typeof options === "function") {
            callback = /** @type {any} */ (options);
            options = new NullObject();
        }
        if (!options) options = new NullObject();
        // the callback is optional: without one, errors go to next(). The router assigns req.next
        // before any handler can run, so by the time sendFile is reachable it is always there.
        // Express's completion handler, exactly: a callback hears everything and the response is
        // left alone, so it can still answer 200 after a 404 error. Without one, a directory
        // falls through as a plain next(), and aborts and write errors go nowhere.
        // the router's next and not the route's: express reports a file it could not serve past
        // the rest of the route, so a four argument handler written inside the route never sees
        // it. _leaveRoute is that; req.next is kept for everything else, see Walk#stepOutOfRoute
        const next = this.req._leaveRoute ?? this.req.next;
        const done = /** @type {(err?: any) => void} */ (
            (err) => {
                if (callback) return callback(err);
                if (err && err.code === "EISDIR") return next();
                if (err && err.code !== "ECONNABORTED" && err.syscall !== "write") next(err);
            }
        );
        // default options
        // Normalised the way send does, and it is not fussiness: max-age takes a non-negative
        // integer count of seconds, so 0.5, -1 and Infinity are all invalid, and a client that
        // cannot read the directive may throw away the whole Cache-Control header with it. A
        // fractional maxAge came out as "max-age=0.5" here, a negative one as "max-age=-1" and
        // Infinity as "max-age=Infinity".
        // Number() around the lot, and not only around the branch that is already a number: ms()
        // answers undefined for a duration it cannot read, and Number.isNaN(undefined) is false,
        // so an unreadable string reached the header as "max-age=NaN".
        const maxAge = Number(
            typeof options.maxAge === "string" ? ms(/** @type {any} */ (options.maxAge)) : options.maxAge
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
        // Express wires the app's setting straight into send here and drops whatever the caller
        // passed, so res.sendFile(p, { etag: false }) still sends one while the app has ETags on.
        // express.static is the opposite: serve-static never asks the app, so a static file keeps
        // its ETag even under app.set("etag", false). It says so with _ownEtag.
        if (!options._ownEtag) {
            options.etag = this.app.get("etag") !== false;
        }

        // path checks
        if (!options.root && !isAbsolute(path)) {
            // thrown rather than reported to the callback, as Express throws it. A relative path
            // with no root is the calling code being wrong, not the request, and there is nothing
            // the caller's error branch could usefully do with it.
            throw new TypeError("path must be absolute or specify root to res.sendFile");
        }
        if (!options.skipEncodePath) {
            path = encodeURI(path);
        }
        // decode reports failure with -1 rather than throwing, so it needs its own binding before
        // it can go back into path
        const decoded = decode(path);
        if (decoded === -1) {
            return done(httpError(400));
        }
        path = decoded;
        if (~path.indexOf("\0")) {
            return done(httpError(400));
        }
        // send's two branches: with a root the path is normalized first, so an in-root ".." like
        // /sub/../index.html collapses and is served, and only a path still escaping after
        // normalization is refused. Without a root any ".." is refused on the raw path.
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
                    // the file segment alone: with a root the normalized parts no longer carry a
                    // leading empty segment, so a bare dotfile can be the only part
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
                stat = cachedStat(fullpath, this.app.settings["stat cache ms"]);
            } catch (err) {
                // the fs error itself, carrying its errno and path, with send's status written on
                // it: a missing file is the request's 404, an unreadable one is the server's 500
                return done(asStatError(/** @type {any} */ (err)));
            }
            if (stat.isDirectory()) {
                // Express reports a directory as an EISDIR with no status, because send tells it
                // apart from an error: it emits "directory", and res.sendFile has no listener for
                // one. So this is not a 404, and an error handler reading err.code sees the code
                // it expects. Without a callback, done() turns it into a plain next().
                const err = /** @type {any} */ (new Error("EISDIR, read"));
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
                // setHeader, not set: Express hands these to send, which writes them through node's
                // setHeader, so a Content-Type given here is written exactly as given. res.set would
                // append a charset and turn "text/x-custom" into "text/x-custom; charset=utf-8",
                // which is a different media type from the one the caller asked for.
                this.setHeader(header, options.headers[header]);
            }
        }
        if (options.setHeaders) {
            options.setHeaders(/** @type {any} */ (this), fullpath, stat);
        }

        // etag, from the stat and never from the app's "etag fn". send computes this itself with
        // the etag package, so neither a custom fn nor app.set("etag", "strong") reaches a file's
        // ETag on Express either.
        if (options.etag && !this.headers["etag"]) {
            this.headers["etag"] = statTag(stat, true);
        }

        // announced before the conditional checks, because those can return early and the header
        // still belongs on the response. send does it in the same order, so a 412 or a 416 still
        // tells the client that ranges are available.
        if (options.acceptRanges) {
            this.headers["accept-ranges"] = "bytes";
        }

        // conditional requests
        if (isPreconditionFailure(this.req, this)) {
            return done(httpError(412));
        }

        // if-modified-since, if-none-match. Before range handling, as send orders it: a fresh
        // request with an unsatisfiable Range gets the 304, never the 416.
        if (this.req.fresh) {
            // the same fields send removes: everything describing a body that is not being sent.
            delete this.headers["content-type"];
            delete this.headers["content-encoding"];
            delete this.headers["content-language"];
            delete this.headers["content-length"];
            this.status(304);
            this.end();
            // the response is complete, so a callback hears about it. Never done(): on success
            // that would be next(), and the request would fall through to the next handler.
            if (callback) callback();
            return;
        }

        // the start and end options, before the Range header: send serves ranges relative to the
        // window they select, so both the parse and the Content-Range total use the windowed len
        let offset = options.start || 0;
        let len = Math.max(0, stat.size - offset);
        if (options.end !== undefined) {
            const bytes = options.end - offset + 1;
            if (len > bytes) len = bytes;
        }

        // range requests
        if (options.acceptRanges) {
            if (this.req.headers.range) {
                // the branch above established the header is there, so range() cannot answer
                // the undefined it uses to mean "no Range header"
                let ranges = /** @type {ReturnType<typeof import("range-parser")>} */ (
                    this.req.range(len, { combine: true })
                );

                // if-range
                if (!isRangeFresh(this.req, this)) {
                    ranges = -2;
                }

                if (ranges === -1) {
                    // the header goes on the response itself, as send writes it before raising
                    // the error, and the status stays on the error for the handler to apply
                    this.headers["content-range"] = `bytes */${len}`;
                    return done(httpError(416));
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

        // Turning the etag off means this file goes out without one, and only this file: the
        // exits above hand an error to the application, and the body its handler sends computes
        // its own etag, as it does on express. Suppressing it before those exits made a 416 or a
        // 412 answer without one.
        if (!options.etag) {
            this.req.noEtag = true;
        }

        // anything but the whole file, whether from a Range header or the start/end options,
        // has to go through the read stream with explicit bounds
        const partial = offset > 0 || len < stat.size;

        if (this.req.method === "HEAD") {
            // len, not stat.size: a ranged HEAD answers with the length of the selected part,
            // as send sets it before ending
            this.set("Content-Length", String(len));
            this.end();
            if (callback) callback();
            return;
        }

        // serve smaller files using workers
        if (this.app.workers.length && stat.size < 768 * 1024 && !partial) {
            this.app
                .readSmallFile(fullpath, stat)
                .then((data) => {
                    if (this.finished || this.aborted) {
                        // the client went away while the worker was reading. Express reports
                        // ECONNABORTED to a callback and never to next(), so aborts stay out of
                        // the error middleware.
                        if (this.aborted && callback) {
                            const err = /** @type {any} */ (new Error("Request aborted"));
                            err.code = "ECONNABORTED";
                            callback(err);
                        }
                        return;
                    }
                    this.end(data);
                    if (callback) callback();
                })
                .catch((err) => {
                    // the worker posts only the message, so recover the fs code from it and put
                    // send's status back on: an ENOENT is the request's 404, not a bare 500
                    const code = /\b(E[A-Z]+)\b/.exec(err.message);
                    if (code && !err.code) err.code = code[1];
                    done(asStatError(err));
                });
        } else {
            // larger files or range requests are piped over response
            const opts = {
                highWaterMark: HIGH_WATERMARK
            };
            if (partial) {
                opts.start = offset;
                opts.end = Math.max(offset, offset + len - 1);
            }
            const file = fs.createReadStream(fullpath, opts);
            this.set("Content-Length", String(len));
            // pipe() forwards nothing from the source, so a read error after the stat, the file
            // gone or unreadable, must reach next()/the callback instead of crashing the process
            file.on("error", (err) => {
                file.destroy();
                if (!this.headersSent) return done(asStatError(err));
                this.destroy(err);
                if (callback) callback(err);
            });
            // a client abort never reaches the source either: it surfaces as "close" on the
            // response or its socket, and without this the fd stays open until the process exits
            const socket = this.socket;
            const cleanup = () => file.destroy();
            this.once("close", cleanup);
            socket?.once("close", cleanup);
            file.once("close", () => {
                this.removeListener("close", cleanup);
                socket?.removeListener("close", cleanup);
            });
            // "end" only fires on a full read, and never together with "error", so the callback
            // hears about completion exactly once, as it does on the worker path
            if (callback) {
                file.once("end", () => callback());
            }
            file.pipe(this);
        }
    }

    /**
     * Sends a file as an attachment, so the browser saves it instead of displaying it.
     *
     * `filename` and `options` can both be left out, and a function in either position is taken
     * as the callback.
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

        // support function as second or third arg
        if (typeof filename === "function") {
            done = /** @type {any} */ (filename);
            name = null;
            opts = null;
        } else if (typeof options === "function") {
            done = /** @type {any} */ (options);
            opts = null;
        }

        // support optional filename, where options may be in it's place
        if (typeof filename === "object" && (typeof options === "function" || options === undefined)) {
            name = null;
            opts = filename;
        }

        // Handed to sendFile as a header option rather than set here, as Express does: headers
        // from the options only go out once the stat has succeeded, so a 404 or a 403 carries no
        // Content-Disposition. The Content-Type still comes from the file's own extension.
        const headers = {
            "Content-Disposition": contentDisposition(name || path)
        };

        // merge user-provided headers, which never get to override the disposition
        if (opts && opts.headers) {
            for (const key of Object.keys(opts.headers)) {
                if (key.toLowerCase() !== "content-disposition") {
                    headers[key] = opts.headers[key];
                }
            }
        }

        // merge user-provided options
        const merged = Object.create(opts ?? null);
        merged.headers = headers;

        // resolved here so a relative path works against cwd, exactly as Express resolves it
        const fullPath = !merged.root ? Path.resolve(path) : path;

        return this.sendFile(fullPath, merged, done);
    }

    /**
     * Sets a header, node's way: no charset is added to a content-type, since node does not know
     * what a media type is. res.set does that, and is what Express code should use.
     *
     * @param {string} field
     * @param {any} value an array sends the header once per entry
     * @returns {this}
     * @throws {Error} once the headers have gone out
     * @throws {TypeError} if the name is not a token, the value is undefined, or the value holds a
     *   character that cannot go on the wire
     */
    setHeader(field, value) {
        if (this.headersSent) {
            throw new Error("Cannot set headers after they are sent to the client");
        }
        validateHeaderName(field);
        if (value === undefined) {
            /** @type {NodeJS.ErrnoException} */
            const err = new TypeError(`Invalid value "undefined" for header "${field}"`);
            err.code = "ERR_HTTP_INVALID_HEADER_VALUE";
            throw err;
        }
        // each entry as text, as node serialises them: a raw number reaching uWS's writeHeader
        // would throw mid-response. Coerced before it is checked, since that is the string the
        // wire gets, and checked before it is stored: a value that got in here would be written by
        // whatever flushes next, and on the error path that is a second throw with nobody left to
        // catch it
        const out = Array.isArray(value) ? value.map(String) : String(value);
        validateHeaderValue(field, out);
        this.headers[field.toLowerCase()] = out;
        return this;
    }

    /**
     * Throws away any header that could not be written, so that flushing this response cannot fail
     * on one. setHeader refuses these on the way in, but `res.headers` is the live object, so an
     * assignment into that still gets a value in here.
     *
     * Only the error page calls it. A throw out of the flush there is not recoverable: the error
     * page is what runs after a throw, so it would be the second one, with nobody left to catch
     * it, and on the node shim that is the process. Everything writable is left alone, since a
     * middleware's own headers belong on the error response too.
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
     * Hands the status line and the headers over now, without waiting for a body, which is node's
     * flushHeaders(). Callers use it to let the client start on the head while the body is still
     * being produced, and one of them is `@angular/ssr`'s writeResponseToNodeResponse, which calls
     * it before streaming a rendered page.
     *
     * **The head does not reach the wire here.** uWS holds it until the first body chunk, so a
     * client sees nothing until then, where express answers at once. `beginWrite` is uWS's API for
     * this and is unusable: it emits a stray CRLF before the first chunk size, which node's parser
     * rejects as HPE_INVALID_CHUNK_SIZE. Checked against v20.69.0, the latest release.
     *
     * A second call does nothing, as node's does. Nothing is written for a response already
     * finished or aborted: uWS has let go of it by then.
     *
     * @returns {void}
     */
    flushHeaders() {
        if (this.headersSent || this.finished || this.aborted) {
            return;
        }
        this._res.cork(() => {
            this.writeHead(this.statusCode);
            // the same rule the chunked write path follows: uWS emits the 200 head itself, byte for
            // byte, so writing it again would only cost a crossing
            if (this.statusCode !== 200 || this.statusText !== undefined) {
                this._res.writeStatus(statusLine(this.statusCode, this.statusText));
            }
            // true, as the chunked path passes for a string chunk: what follows a flush is a body
            // written in pieces, and the framing has to be the one that allows them
            this.writeHeaders(true);
        });
    }

    /**
     * node's `writeEarlyHints`, which sends a `103` carrying the resources the page will want, so a
     * browser can start fetching them while the server is still rendering.
     *
     * **Nothing is sent here.** µWebSockets.js has no API for an informational response, so the
     * hints cannot reach the wire, and this exists so that code written for Express keeps running
     * rather than dying on "res.writeEarlyHints is not a function". The callback is still called,
     * because node calls it once the hints are out and a caller may be waiting on it.
     *
     * `writeContinue` and `writeProcessing` below are the same story with `100` and `102`.
     *
     * @param {Record<string, string|string[]>} [hints]
     * @param {() => void} [callback]
     * @returns {void}
     */
    writeEarlyHints(hints, callback) {
        this.#refuseInformationAfterHead();
        // node writes the hints first and calls back after, so a caller that sequences work on it
        // gets the same order here
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
     * node throws from all three of the above once the head has gone out, since an informational
     * response can only come before it, and an application may well be relying on that throw.
     *
     * @returns {void}
     */
    #refuseInformationAfterHead() {
        if (this.headersSent) {
            /** @type {NodeJS.ErrnoException} */
            const err = new Error("Cannot write headers after they are sent to the client");
            err.code = "ERR_HTTP_HEADERS_SENT";
            throw err;
        }
    }

    /**
     * node's `addTrailers`, the headers that follow a chunked body. µWebSockets.js cannot send
     * them, so nothing is written and the response is otherwise unaffected.
     *
     * @param {Record<string, string>|[string, string][]} [headers]
     * @returns {void}
     */
    addTrailers(headers) {}

    /**
     * node's per-response socket timeout. µWS runs its own idle timeout, set through
     * `uwsOptions.idleTimeout`, and this cannot change it. The callback is registered on "timeout"
     * as node's does, so nothing is lost by calling it, and nothing happens either.
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
     * node's `assignSocket`, which the http server uses when a response is
     * handed a raw socket. There is no such socket here.
     *
     * @param {any} [socket]
     * @returns {void}
     */
    assignSocket(socket) {}

    /**
     * node's `detachSocket`, which the http server uses when a response is
     * handed a raw socket. There is no such socket here.
     * @param {any} [socket]
     * @returns {void}
     */
    detachSocket(socket) {}

    /**
     * node's `statusMessage`, the reason phrase. It is held as `statusText` here, and the two are
     * the same thing: this is the name node and Express use, so code that sets it keeps working.
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
     * Whether a header has been set on this response, which is node's `hasHeader`. Names are
     * compared lowercased, as node compares them.
     *
     * @param {string} name
     * @returns {boolean}
     */
    hasHeader(name) {
        return this.headers[name.toLowerCase()] !== undefined;
    }

    /**
     * The names of the headers set so far, lowercased, which is node's `getHeaderNames`.
     *
     * @returns {string[]}
     */
    getHeaderNames() {
        return Object.keys(this.headers);
    }

    /**
     * node's `getRawHeaderNames`, which returns the names in the case they were set in. Header
     * names are held lowercased here, so this returns what {@link Response#getHeaderNames} does.
     *
     * @returns {string[]}
     */
    getRawHeaderNames() {
        return Object.keys(this.headers);
    }

    /**
     * Adds a value to a header without replacing what is there, which is node's `appendHeader`.
     * A header that already has one value becomes a list, as node makes it.
     *
     * @param {string} name
     * @param {string|readonly string[]} value
     * @returns {this}
     */
    appendHeader(name, value) {
        const key = name.toLowerCase();
        const current = this.headers[key];
        if (current === undefined) {
            return this.setHeader(name, /** @type {any} */ (value));
        }
        const merged = [].concat(/** @type {any} */ (current), /** @type {any} */ (value));
        return this.setHeader(name, /** @type {any} */ (merged));
    }

    /**
     * Sets several headers at once from a Headers or a Map, which is node's `setHeaders`. A
     * `Headers` gives `set-cookie` back through getSetCookie, so those stay separate values rather
     * than one folded string.
     *
     * @param {Headers|Map<string, string|readonly string[]>} headers
     * @returns {this}
     */
    setHeaders(headers) {
        if (typeof Headers === "function" && headers instanceof Headers) {
            for (const name of new Set([...headers.keys()])) {
                if (name === "set-cookie") {
                    this.setHeader(name, /** @type {any} */ (headers.getSetCookie()));
                } else {
                    this.setHeader(name, /** @type {any} */ (headers.get(name)));
                }
            }
            return this;
        }
        for (const [name, value] of headers) {
            this.setHeader(name, /** @type {any} */ (value));
        }
        return this;
    }

    /**
     * Node asks this before validating a header value, and answering true keeps it permissive.
     * Only reached through code that goes down node's own header path.
     */
    _isLenientHeaderValidation() {
        // Node.js internal function for lenient header validation
        // Returns true to allow more permissive header value validation
        return true;
    }

    /**
     * The Express name for set(), including the charset it adds to a content-type.
     * @param {any} field a header name, or an object of them
     * @param {any} [value]
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
            for (const header in field) {
                // through set() and not straight to setHeader, so that a whole object of headers
                // gets the same coercion and the same Content-Type handling as one set at a time
                this.set(header, field[header]);
            }
        } else {
            const name = field.toLowerCase();
            // a header is text on the wire whatever it was here, and Express coerces at this point,
            // so res.get answers what was sent rather than the number or object it was given
            let out = Array.isArray(value) ? value.map(String) : String(value);
            if (name === "content-type") {
                if (Array.isArray(out)) {
                    throw new TypeError("Content-Type cannot be set to an Array");
                }
                // every type the mime database gives a charset, not a list of three. The list was
                // missing application/manifest+json among others, which Express does charset.
                out = withDefaultCharset(out);
            }
            // the name as it was written, not the lowercased one: setHeader lowercases it itself,
            // and it is the name that a refused header is reported by, which Express takes from
            // what the caller passed
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
        // Content-Length is on the wire but not in here: uWS measures the body it is handed and
        // writes the header itself, which saves measuring it twice. Express sets it in send(), so
        // anything reading it back finds it there, and morgan's common and combined formats do
        // exactly that on every line they write. Worked out here rather than in send() so a
        // response nobody asks pays nothing, and kept once worked out.
        if (value === undefined && name === "content-length" && this._sentBody !== undefined) {
            const length = Buffer.byteLength(this._sentBody);
            this.headers["content-length"] = String(length);
            return String(length);
        }
        return value;
    }

    /**
     * Reads a header that has been set, case insensitively. node's name for get().
     * @param {string} field
     * @returns {string|string[]|undefined}
     */
    getHeader(field) {
        return this.get(field);
    }

    /**
     * Every header set so far, as a shallow copy on a null prototype, which is what node's
     * OutgoingMessage answers. It used to hand out the live object, and a write into that
     * reached the wire without setHeader's validation, see issue #6; nothing in here or in the
     * middleware that was checked relies on the live one, so the copy costs an allocation on a
     * method the framework itself never calls.
     * @returns {Record<string, any>}
     */
    getHeaders() {
        return Object.assign({ __proto__: null }, this.headers);
    }

    /**
     * Removes a header that has not been flushed yet.
     *
     * Returns nothing, the way node's OutgoingMessage does. Returning the response would let
     * chains be written here that break the moment the same code runs on Express.
     *
     * @param {string} field
     */
    removeHeader(field) {
        delete this.headers[field.toLowerCase()];
    }

    /**
     * Adds a header without replacing what is already there, which is what Set-Cookie and Vary
     * need.
     * @param {string} field
     * @param {string|string[]} value
     * @returns {this}
     */
    append(field, value) {
        // merged and then routed through set(), as Express does, so the values get the same
        // String coercion and Content-Type handling as any other header
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
     * Renders a view and sends it. With a callback the result goes to the callback instead, and
     * nothing is sent. A function in the options position is taken as the callback.
     * @param {string} view view name
     * @param {Record<string, any>} [options] locals for the view
     * @param {(err: Error|null, html?: string) => void} [callback]
     */
    render(view, options, callback) {
        if (typeof options === "function") {
            callback = /** @type {any} */ (options);
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
                // the router's next and not the route's, the same as sendFile: express reports a
                // view it could not render to req.next, which the router owns, so the rest of the
                // route is skipped and a four argument handler written inside it never sees the
                // error. A callback, when there is one, hears everything instead
                if (err) return (this.req._leaveRoute ?? this.req.next)(err);
                this.send(str);
            });

        // use req.app like express does, so mounted sub-apps resolve views with their own settings
        this.req.app.render(view, options, done);
    }

    /**
     * Appends a Set-Cookie header. An object value is serialised as JSON. With `signed` the
     * cookie is signed using the secret given to cookie-parser.
     * @param {string} name
     * @param {string|object} value
     * @param {{maxAge?: number, expires?: Date, path?: string, domain?: string, secure?: boolean,
     *   httpOnly?: boolean, sameSite?: boolean|"lax"|"strict"|"none", signed?: boolean,
     *   priority?: "low"|"medium"|"high", partitioned?: boolean}} [options]
     * @returns {this}
     */
    cookie(name, value, options) {
        const opt = { ...(options ?? {}) }; // create a new ref because we change original object (https://github.com/dimdenGD/ultimate-express/issues/68)
        // cookie-parser hangs the secret on the request, so it is read off it rather than
        // declared here: without that middleware there is none, which is what this checks
        const req = /** @type {any} */ (this.req);
        if (opt.signed && !req.secret) {
            // the message has to read like this: it is the one Express throws, and it names the
            // thing that is actually missing rather than the library that noticed
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
            // Express carries a null maxAge through to a cookie package that ignores it. Ours
            // refuses it, so it is dropped here instead: no Max-Age is what both end up sending
            delete opt.maxAge;
        }
        if (opt.signed) {
            val = "s:" + sign(val, req.secret);
        }

        if (opt.path == null) {
            opt.path = "/";
        }

        this.append("Set-Cookie", cookie.serialize(name, val, opt));
        return this;
    }

    /**
     * Clears a cookie. The browser only matches it if `path` and `domain` are the ones it was
     * set with. Any `maxAge` or `expires` passed here is ignored, since clearing is defined as
     * expiring it immediately.
     * @param {string} name
     * @param {Record<string, any>} [options]
     * @returns {this}
     */
    clearCookie(name, options) {
        // clearing is defined as expiring now, so any maxAge passed in is dropped rather than honoured
        /** @type {Record<string, any>} */
        const opts = { path: "/", ...options, expires: new Date(1) };
        delete opts.maxAge;
        return this.cookie(name, "", opts);
    }

    /**
     * Sets Content-Disposition to attachment, and Content-Type from the extension when a
     * filename is given.
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
     * Answers according to the Accept header, calling the handler whose key matches best. A
     * `default` key catches everything else; without one an unmatched request gets 406.
     * Sets Vary: Accept.
     * @param {Record<string, any>} object handlers keyed by extension or mime type
     * @returns {this}
     */
    format(object) {
        const keys = Object.keys(object).filter((v) => v !== "default");
        // accepts answers the whole list only when asked with no arguments; given types it
        // answers the best of them, or false
        const key = keys.length > 0 ? /** @type {string|false} */ (this.req.accepts(keys)) : false;

        this.vary("Accept");

        // the router next, as express hands over: inside a route with a four argument handler of
        // its own, a 406 leaves the route rather than being caught by that handler. Where the two
        // are the same step, _leaveRoute is the very object the surrounding layer received, which
        // is what express's own test asserts, see Walk#runRoute
        const next = this.req._leaveRoute ?? this.req.next;
        if (key) {
            this.set("Content-Type", normalizeType(key).value);
            object[key](this.req, this, next);
        } else if (object.default) {
            object.default(this.req, this, next);
        } else {
            // an error and not an answer: express hands the error handler the types it could have
            // sent, which is how an application says what it supports
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
        if (!this.headers["content-type"]) {
            this.headers["content-type"] = "application/json; charset=utf-8";
        }
        const hot = this.app._hot();
        return this.send(stringify(body, hot.jsonReplacer, hot.jsonSpaces, hot.jsonEscape));
    }

    /**
     * Sends JSON wrapped in a callback when the query names one, under the setting
     * "jsonp callback name", which defaults to "callback". Without it this is plain JSON.
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
                // replace chars not allowed in JavaScript that are in JSON
                body = body.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
            }
            body = "/**/ typeof " + callback + " === 'function' && " + callback + "(" + body + ");";
            js = true;
        }

        if (!this.headers["content-type"]) {
            this.headers["x-content-type-options"] = "nosniff";
            this.headers["content-type"] = "application/json; charset=utf-8";
        }
        if (js) {
            // with a callback the body is script whatever type was asked for before, so this
            // overrides rather than filling in, and the nosniff goes with it
            this.headers["x-content-type-options"] = "nosniff";
            this.headers["content-type"] = "text/javascript; charset=utf-8";
        }

        return this.send(body);
    }

    /**
     * Adds to the Link header, one entry per key, the key being the rel.
     * @param {Record<string, any>} links rel to url
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
                        // an array is several links that share a rel, one entry each, and not one
                        // entry holding a comma separated list inside its angle brackets
                        if (Array.isArray(target)) {
                            return target.map((one) => "<" + one + '>; rel="' + rel + '"').join(", ");
                        }
                        return "<" + target + '>; rel="' + rel + '"';
                    })
                    .join(", ")
        );
    }

    /**
     * Sets the Location header, URL-encoding the value.
     *
     * "back" is a literal location here, not the Referrer: that shortcut is gone in Express 5.
     *
     * @param {string} path
     * @returns {this}
     */
    location(path) {
        // Express 5 dropped the magic where 'back' meant the Referrer header. It is now just a
        // relative URL like any other, which is what res.redirect('back') also does here.
        this.headers["location"] = encodeUrl(path);
        return this;
    }

    /**
     * Redirects, defaulting to 302. The status may be given first, as `redirect(301, url)`.
     * The body is a short note in whichever format the client accepts.
     * @param {number|string} status status code, or the url when the status is left out
     * @param {string} [url]
     * @param {boolean} [forceHtml] answer with an HTML body whatever the client accepts
     */
    redirect(status, url, forceHtml = false) {
        if (typeof status !== "number" && !url) {
            url = status;
            status = 302;
        }
        this.location(/** @type {string} */ (url));
        this.status(/** @type {number} */ (status));

        // a string, because location() has just set it to one. get() has to allow the array form for
        // the headers that can repeat, and escapeHtml quite reasonably only takes a string
        const address = /** @type {string} */ (this.get("Location"));
        let body;
        // Support text/{plain,html} by default
        if (forceHtml) {
            // uppercase on purpose: this branch stands in for the redirect that send and
            // serve-static emit, and both of those write "charset=UTF-8". res.redirect() below
            // goes through format(), which takes the lowercase form from the mime lookup.
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
                    body = `${statuses.message[status]}. Redirecting to ${address}`;
                },
                html: () => {
                    this.set("Content-Type", "text/html; charset=utf-8");
                    body = `<p>${statuses.message[status]}. Redirecting to ${escapeHtml(address)}</p>`;
                },
                default: () => {
                    // no Content-Type on purpose: Express leaves the header off entirely when
                    // the client accepts neither text nor html
                    body = "";
                }
            });
        }
        // set before the HEAD check, as Express has it, so a HEAD answers with the length the
        // GET body would have instead of 0
        this.set("Content-Length", String(Buffer.byteLength(body ?? "")));
        if (this.req.method === "HEAD") {
            this.end();
        } else {
            this.end(body);
        }
    }

    /**
     * Sets Content-Type. An extension is looked up as a mime type and gets a charset; anything
     * containing a slash is used as written. Also available as `contentType()`.
     * @param {string} type
     * @returns {this}
     */
    type(type) {
        const ct = type.indexOf("/") === -1 ? contentTypeFor(type) : type;

        // the name Express passes, since a refused value is reported by the name it was set under
        return this.set("Content-Type", ct);
    }

    /**
     * Adds a field to Vary, without repeating one already there.
     * @param {string|string[]} field
     * @returns {this}
     * @throws {TypeError} if no field is given, since a Vary with nothing in it is a mistake
     */
    vary(field) {
        // the vary package decides: it throws when there is no field at all, and does nothing at
        // all for an empty list, which is not the same thing and used to be refused here as well
        vary(/** @type {any} */ (this), field);
        return this;
    }

    /** The same object as socket, which node carries under both names. */
    get connection() {
        return this.socket;
    }

    /**
     * Whether the response has been fully written. Writable declares this as a plain property and
     * the machinery that would maintain it is bypassed here, so a getter over our own flag replaces
     * it. The directive below has to sit outside this block, or it reads as a JSDoc tag.
     */
    // @ts-expect-error TS2611, the accessor replacing the base property is deliberate. Expect
    // rather than ignore, so it fails loudly if it ever stops applying.
    get writableFinished() {
        return this.finished;
    }
};

// res.contentType is res.type under express's other name. On the prototype rather than an instance
// field, which wrote one own property per response in the constructor.
/** @type {any} */ (module.exports.prototype).contentType = module.exports.prototype.type;
