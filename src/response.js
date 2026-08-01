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
const etag = require("etag");

const outgoingMessage = new http.OutgoingMessage();
const symbols = Object.getOwnPropertySymbols(outgoingMessage);
// if a future node renames it, fall back to a private symbol rather than writing a property
// literally named "undefined", which is what indexing with undefined would do
const kOutHeaders = symbols.find((s) => s.toString() === "Symbol(kOutHeaders)") ?? Symbol("kOutHeaders");
const HIGH_WATERMARK = 128 * 1024;

class Socket extends EventEmitter {
    constructor(response) {
        super();
        this.response = response;

        this.on("error", (err) => {
            this.emit("close");
        });
    }
    get writable() {
        return !this.response.finished;
    }

    end(body) {
        this.response.end(body);
    }

    close() {
        if (this.response.finished) {
            return;
        }
        this.response.finished = true;
        this.emit("close");
        this.response._res.close();
    }
}

module.exports = class Response extends Writable {
    /** @type {Socket|null} */
    #socket = null;
    #ended = false;
    /** @type {((err?: Error|null) => void)|null} */
    #pendingCallback = null;
    req;
    constructor(res, req, app) {
        super();
        this._req = req;
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
        this.headers = {
            connection: "keep-alive",
            "keep-alive": "timeout=10"
        };
        if (this.app.get("x-powered-by")) {
            this.headers["x-powered-by"] = "Fulmine";
        }

        // support for node internal
        this[kOutHeaders] = new Proxy(this.headers, {
            set: (obj, prop, value) => {
                this.set(prop, value[1]);
                return true;
            },
            get: (obj, prop) => {
                return obj[prop];
            }
        });
        this.body = undefined;
        this.on("error", (err) => {
            if (this.finished) {
                return;
            }
            this._res.cork(() => {
                this._res.close();
                this.finished = true;
                this.#socket?.emit("close");
            });
        });
        this.once("close", () => {
            this.#ended = true;
        });
    }

    get socket() {
        if (this.#ended) return null;
        if (!this.#socket) {
            this.#socket = new Socket(this);
        }
        return this.#socket;
    }

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
                const statusMessage = this.statusText ?? statuses.message[this.statusCode] ?? "";
                this._res.writeStatus(`${this.statusCode} ${statusMessage}`.trim());
                this.writeHeaders(typeof chunk === "string");
            }

            if (!Buffer.isBuffer(chunk) && !(chunk instanceof ArrayBuffer)) {
                chunk = Buffer.from(chunk);
                chunk = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
            }

            if (this.chunkedTransfer) {
                const ok = this._res.write(chunk);
                if (ok) {
                    this.writingChunk = false;
                    callback(null);
                } else {
                    this.#pendingCallback = callback;
                    this._res.onWritable(() => {
                        if (this.aborted || this.finished) return true;
                        const cb = this.#pendingCallback;
                        this.#pendingCallback = null;
                        this.writingChunk = false;
                        if (cb) cb(null);
                        return true;
                    });
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
    writeHead(statusCode, statusMessage, headers) {
        this.statusCode = statusCode;
        if (typeof statusMessage === "string") {
            this.statusText = statusMessage;
        }
        if (!headers) {
            if (!statusMessage) return this;
            headers = statusMessage;
        }
        for (const header in headers) {
            this.set(header, headers[header]);
        }
        return this;
    }
    writeHeaders(utf8) {
        for (const header in this.headers) {
            const value = this.headers[header];
            if (header === "content-length") {
                // if content-length is set, disable chunked transfer encoding, since size is known
                this.chunkedTransfer = false;
                this.totalSize = parseInt(value);
                continue;
            }
            if (Array.isArray(value)) {
                for (const val of value) {
                    this._res.writeHeader(header, val);
                }
            } else {
                this._res.writeHeader(header, value);
            }
        }
        this.headersSent = true;
    }
    _implicitHeader() {
        // compatibility function
        // usually should send headers but this is useless for us
        this.writeHead(this.statusCode);
    }
    /**
     * Sets the status code.
     * @param {number|string} code an integer from 100 to 999
     * @returns {this} the response, for chaining
     * @throws {RangeError} if the code is outside that range or is not an integer
     */
    status(code) {
        // Express 5 rejects anything that is not a plausible status code, instead of writing
        // NaN or a nonsense number into the response line
        const statusCode = parseInt(String(code), 10);
        if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 999) {
            throw new RangeError(`Invalid status code: ${code}`);
        }
        this.statusCode = statusCode;
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
        this._res.cork(() => {
            if (!this.headersSent) {
                const etagFn = this.app.get("etag fn");
                if (etagFn && data && !this.headers["etag"] && !this.req.noEtag) {
                    this.headers["etag"] = etagFn(data);
                }
                const fresh = this.req.fresh;
                const statusMessage = this.statusText ?? statuses.message[this.statusCode] ?? "";
                this._res.writeStatus(fresh ? "304 Not Modified" : `${this.statusCode} ${statusMessage}`.trim());
                this.writeHeaders(true);
                if (fresh) {
                    this._res.end();
                    this.finished = true;
                    this.#socket?.emit("close");
                    this.emit("finish");
                    this.emit("close");
                    cb &&
                        queueMicrotask(() => {
                            this.#ended = true;
                            cb();
                        });
                    return;
                }
            }
            const contentLength = this.headers["content-length"];
            if (!data && contentLength) {
                this._res.endWithoutBody(contentLength.toString());
            } else {
                if (data instanceof Buffer) {
                    data = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                }
                if (this.req.method === "HEAD") {
                    const length = Buffer.byteLength(data ?? "");
                    this._res.endWithoutBody(length.toString());
                } else {
                    this._res.end(data);
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
        });
        return this;
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
        const isBuffer = Buffer.isBuffer(body);
        if (body === null || body === undefined) {
            body = "";
            return this.end(body);
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
                this.headers["content-type"] = "text/html; charset=utf-8";
            } else if (!contentType.includes(";")) {
                this.headers["content-type"] += "; charset=utf-8";
            }
        } else {
            if (!this.headers["content-type"]) {
                this.headers["content-type"] = "application/octet-stream";
            }
        }
        return this.end(body);
    }

    /**
     * Streams a file, setting Content-Type from the extension and answering conditional and
     * range requests.
     *
     * The path must be absolute unless `options.root` is given. A function in the options
     * position is taken as the callback.
     *
     * Options: `root`, `maxAge`, `lastModified`, `headers`, `dotfiles` ("allow", "deny" or
     * "ignore"), `acceptRanges`, `cacheControl`, `immutable`, `etag` and `setHeaders`.
     *
     * @param {string} path
     * @param {Record<string, any>} [options]
     * @param {(err?: Error) => void} [callback] called once sent, or with the error
     */
    sendFile(path, options = new NullObject(), callback) {
        if (typeof path !== "string") {
            throw new TypeError("path argument is required to res.sendFile");
        }
        if (typeof options === "function") {
            callback = /** @type {any} */ (options);
            options = new NullObject();
        }
        if (!options) options = new NullObject();
        // the callback is optional: without one, errors go to next(). The router assigns req.next
        // before any handler can run, so by the time sendFile is reachable it is always there.
        const done = /** @type {(err?: Error) => void} */ (callback ?? this.req.next);
        // default options
        if (typeof options.maxAge === "string") {
            options.maxAge = ms(/** @type {any} */ (options.maxAge));
        } else if (typeof options.maxAge === "undefined") {
            options.maxAge = 0;
        }
        if (typeof options.lastModified === "undefined") {
            options.lastModified = true;
        }
        if (typeof options.cacheControl === "undefined") {
            options.cacheControl = true;
        }
        if (typeof options.acceptRanges === "undefined") {
            options.acceptRanges = true;
        }
        if (typeof options.etag === "undefined") {
            options.etag = this.app.get("etag") !== false;
        }
        let etagFn = this.app.get("etag fn");
        if (options.etag && !etagFn) {
            etagFn = (stat) => {
                return etag(stat, { weak: true });
            };
        }

        // path checks
        if (!options.root && !isAbsolute(path)) {
            this.status(500);
            return done(new Error("path must be absolute or specify root to res.sendFile"));
        }
        if (!options.skipEncodePath) {
            path = encodeURI(path);
        }
        // decode reports failure with -1 rather than throwing, so it needs its own binding before
        // it can go back into path
        const decoded = decode(path);
        if (decoded === -1) {
            this.status(400);
            return done(new Error("Bad Request"));
        }
        path = decoded;
        if (~path.indexOf("\0")) {
            this.status(400);
            return done(new Error("Bad Request"));
        }
        if (UP_PATH_REGEXP.test(path)) {
            this.status(403);
            return done(new Error("Forbidden"));
        }
        const parts = Path.normalize(path).split(Path.sep);
        const fullpath = options.root ? Path.resolve(Path.join(options.root, path)) : path;
        if (options.root && !fullpath.startsWith(Path.resolve(options.root))) {
            this.status(403);
            return done(new Error("Forbidden"));
        }

        // dotfile checks
        if (containsDotFile(parts)) {
            switch (options.dotfiles) {
                case "allow":
                    break;
                case "deny":
                    this.status(403);
                    return done(new Error("Forbidden"));
                case "ignore_files": {
                    const len = parts.length;
                    if (len > 1 && parts[len - 1].startsWith(".")) {
                        this.status(404);
                        return done(new Error("Not found"));
                    }
                    break;
                }
                case "ignore":
                default:
                    this.status(404);
                    return done(new Error("Not found"));
            }
        }

        let stat = options._stat;
        if (!stat) {
            try {
                stat = fs.statSync(fullpath);
            } catch (err) {
                return done(/** @type {Error} */ (err));
            }
            if (stat.isDirectory()) {
                this.status(404);
                return done(new Error(`Not found`));
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
                `public, max-age=${options.maxAge / 1000}` + (options.immutable ? ", immutable" : "");
        }
        if (options.lastModified) {
            this.headers["last-modified"] = stat.mtime.toUTCString();
        }
        if (options.headers) {
            for (const header in options.headers) {
                this.set(header, options.headers[header]);
            }
        }
        if (options.setHeaders) {
            options.setHeaders(/** @type {any} */ (this), fullpath, stat);
        }

        // etag
        if (options.etag && etagFn && !this.headers["etag"]) {
            this.headers["etag"] = etagFn(stat);
        }
        if (!options.etag) {
            this.req.noEtag = true;
        }

        // conditional requests
        if (isPreconditionFailure(this.req, this)) {
            this.status(412);
            return done(new Error("Precondition Failed"));
        }

        // range requests
        let offset = 0,
            len = stat.size,
            ranged = false;
        if (options.acceptRanges) {
            this.headers["accept-ranges"] = "bytes";
            if (this.req.headers.range) {
                let ranges = this.req.range(stat.size, {
                    combine: true
                });

                // if-range
                if (!isRangeFresh(this.req, this)) {
                    ranges = -2;
                }

                if (ranges === -1) {
                    this.status(416);
                    this.headers["content-range"] = `bytes */${stat.size}`;
                    return done(new Error("Range Not Satisfiable"));
                }
                if (ranges !== -2 && ranges.length === 1) {
                    this.status(206);
                    const range = ranges[0];
                    this.headers["content-range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
                    offset = range.start;
                    len = range.end - range.start + 1;
                    ranged = true;
                }
            }
        }

        // if-modified-since, if-none-match
        if (this.req.fresh) {
            return this.end();
        }

        if (this.req.method === "HEAD") {
            this.set("Content-Length", stat.size);
            return this.end();
        }

        // serve smaller files using workers
        if (this.app.workers.length && stat.size < 768 * 1024 && !ranged) {
            this.app
                .readFileWithWorker(fullpath)
                .then((data) => {
                    if (this._res.finished) {
                        return;
                    }
                    this.end(data);
                    if (callback) callback();
                })
                .catch((err) => {
                    if (callback) callback(err);
                });
        } else {
            // larger files or range requests are piped over response
            const opts = {
                highWaterMark: HIGH_WATERMARK
            };
            if (ranged) {
                opts.start = offset;
                opts.end = Math.max(offset, offset + len - 1);
            }
            const file = fs.createReadStream(fullpath, opts);
            this.set("Content-Length", len);
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
     * @param {Record<string, any>} [options] passed through to sendFile
     * @param {(err?: Error) => void} [callback]
     */
    download(path, filename, options, callback) {
        let done = callback;
        /** @type {string|null|undefined} */
        let name = filename;
        let opts = options || new NullObject();

        // support function as second or third arg
        if (typeof filename === "function") {
            done = /** @type {any} */ (filename);
            name = null;
            opts = {};
        } else if (typeof options === "function") {
            done = /** @type {any} */ (options);
            opts = {};
        }

        // support optional filename, where options may be in it's place
        if (typeof filename === "object" && (typeof options === "function" || options === undefined)) {
            name = null;
            opts = filename;
        }
        if (!name) {
            name = Path.basename(path);
        }
        if (!opts.root && !isAbsolute(path)) {
            opts.root = process.cwd();
        }

        this.attachment(name);
        this.sendFile(path, opts, done);
    }
    setHeader(field, value) {
        if (this.headersSent) {
            throw new Error("Cannot set headers after they are sent to the client");
        }
        if (typeof field !== "string") {
            throw new TypeError("Header name must be a valid HTTP token");
        } else {
            field = field.toLowerCase();
            if (Array.isArray(value)) {
                this.headers[field] = value;
                return this;
            }
            this.headers[field] = String(value);
        }
        return this;
    }
    _isLenientHeaderValidation() {
        // Node.js internal function for lenient header validation
        // Returns true to allow more permissive header value validation
        return true;
    }
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
                this.setHeader(header, field[header]);
            }
        } else {
            field = field.toLowerCase();
            if (field === "content-type") {
                if (
                    typeof value === "string" &&
                    !value.includes("charset=") &&
                    (value.startsWith("text/") || value === "application/json" || value === "application/javascript")
                ) {
                    value += "; charset=utf-8";
                }
            }
            this.setHeader(field, value);
        }
        return this;
    }
    /**
     * Reads a response header that has been set, case insensitively.
     * @param {string} field
     * @returns {string|string[]|undefined}
     */
    get(field) {
        return this.headers[field.toLowerCase()];
    }
    getHeader(field) {
        return this.get(field);
    }
    getHeaders() {
        return this.headers;
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
        field = field.toLowerCase();
        const old = this.headers[field];
        if (old) {
            const newVal = [];
            if (Array.isArray(old)) {
                newVal.push(...old);
            } else {
                newVal.push(old);
            }
            if (Array.isArray(value)) {
                newVal.push(...value);
            } else {
                newVal.push(value);
            }
            this.headers[field] = newVal;
        } else {
            this.headers[field] = value;
        }
        return this;
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
                if (err) return this.req.next(err);
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
        let val = typeof value === "object" ? "j:" + JSON.stringify(value) : String(value);
        if (opt.maxAge != null) {
            const maxAge = opt.maxAge - 0;
            if (!isNaN(maxAge)) {
                opt.expires = new Date(Date.now() + maxAge);
                opt.maxAge = Math.floor(maxAge / 1000);
            }
        }
        if (opt.signed) {
            val = "s:" + sign(val, this.req.secret);
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
        const key = keys.length > 0 ? this.req.accepts(keys) : false;

        this.vary("Accept");

        if (key) {
            this.set("Content-Type", normalizeType(key).value);
            object[key](this.req, this, this.req.next);
        } else if (object.default) {
            object.default(this.req, this, this.req.next);
        } else {
            this.status(406).send(this.app._generateErrorPage("Not Acceptable", this.statusCode, false));
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
        const escape = this.app.get("json escape");
        const replacer = this.app.get("json replacer");
        const spaces = this.app.get("json spaces");
        return this.send(stringify(body, replacer, spaces, escape));
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
            this.headers["content-type"] = `${js ? "text/javascript" : "application/json"}; charset=utf-8`;
            if (js) this.headers["X-Content-Type-Options"] = "nosniff";
        }

        return this.send(body);
    }
    /**
     * Adds to the Link header, one entry per key, the key being the rel.
     * @param {Record<string, any>} links rel to url
     * @returns {this}
     */
    links(links) {
        // this.headers['link'] = Object.entries(links).map(([rel, url]) => `<${url}>; rel="${rel}"`).join(', ');
        // return this;
        let link = this.get("Link") || "";
        if (link) link += ", ";
        return this.set(
            "Link",
            link +
                Object.keys(links)
                    .map(function (rel) {
                        return "<" + links[rel] + '>; rel="' + rel + '"';
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
        this.status(status);

        const address = this.get("Location");
        let body;
        // Support text/{plain,html} by default
        if (forceHtml) {
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
                    this.set("Content-Type", "text/plain; charset=UTF-8");
                    body = `${statuses.message[status]}. Redirecting to ${address}`;
                },
                html: () => {
                    this.set("Content-Type", "text/html; charset=UTF-8");
                    body = `<p>${statuses.message[status]}. Redirecting to ${escapeHtml(address)}</p>`;
                },
                default: () => {
                    this.set("Content-Type", "text/plain; charset=UTF-8");
                    body = "";
                }
            });
        }
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
        const ct = type.indexOf("/") === -1 ? mime.contentType(type) || "application/octet-stream" : type;

        return this.set("content-type", ct);
    }
    contentType = this.type;

    /**
     * Adds a field to Vary, without repeating one already there.
     * @param {string|string[]} field
     * @returns {this}
     * @throws {Error} if no field is given, since a Vary with nothing in it is a mistake
     */
    vary(field) {
        if (!field || (Array.isArray(field) && !field.length)) {
            throw new Error("field argument is required for res.vary()");
        }
        vary(/** @type {any} */ (this), field);
        return this;
    }

    get connection() {
        return this.socket;
    }

    // Writable declares this as a plain property, and the stream machinery that would maintain it
    // is mostly bypassed here, so it is deliberately replaced by a getter over our own flag.
    // TypeScript has no way to say "replacing a base property with an accessor is the intent";
    // @ts-expect-error rather than @ts-ignore, so this fails loudly if it ever stops applying.
    get writableFinished() {
        return this.finished;
    }
};
