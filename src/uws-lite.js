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

// app.uwsLite(): a route µWS serves, whose handler is (req, res) with the part of Express most routes
// use, over two small objects. No per-request closure on the way: the state is on those two objects,
// and the functions µWS calls are bound to them.

const { Buffer } = require("buffer");
const { EventEmitter } = require("events");
const { PassThrough, Readable } = require("stream");
const bytes = require("bytes");
const bodyParser = require("./body-parser.js");
const compression = require("./compression.js");
const parseQuery = require("./parse-query.js");
const { HEADER_VALUE_BUF, statusLine } = require("./response-utils.js");
const { compressor, _respond, _respondWhole } = require("./uws-utils.js");
const {
    contentTypeFor,
    contentTypeSet,
    validateHeaderName,
    validateHeaderValue,
    withUtf8Charset
} = require("./utils.js");

/**
 * @typedef {{
 *   body?: "text"|"json"|"form"|"buffer"|"lent"|"stream",
 *   limit?: number|string,
 *   compress?: boolean | Record<string, unknown>,
 *   headers?: boolean | string[],
 *   url?: boolean,
 *   use?: Function[]
 * }} LiteOptions
 */

const HTML = "text/html; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";
const JSON_UTF8 = "application/json; charset=utf-8";
const OCTET = "application/octet-stream";

// as express.text() and express.json()
const DEFAULT_LIMIT = 100 * 1024;

// keeps a BOM, as express.text() does
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

const NO_PARAMS = /** @type {Record<string, string>} */ (/** @type {unknown} */ (Object.freeze({ __proto__: null })));

// _flags of a response
const ANSWERED = 1;
const ABORTED = 2;
// after the handler returned, outside the cork µWS holds around it
const LATE = 4;

class LiteRequest {
    /**
     * @param {any} req µWS's, good until the handler returns
     * @param {any} route
     * @param {string} rawQuery
     * @param {Record<string, string>} params
     * @param {{url?: string, method?: string, headers?: Record<string, string>, entries?: string[]}|null} kept
     */
    constructor(req, route, rawQuery, params, kept) {
        this._req = req;
        this._route = route;
        this._rawQuery = rawQuery;
        /** @type {Record<string, any>|undefined} */
        this._query = undefined;
        this._kept = kept;
        this.params = params;
        /** @type {any} */
        this.body = undefined;
    }

    /** @returns {Record<string, any>} parsed on the first read */
    get query() {
        return (this._query ??= parseQuery(this._rawQuery));
    }

    /** @returns {Record<string, string>|undefined} what the route keeps, see keep() */
    get headers() {
        const kept = this._kept;
        if (kept?.entries !== undefined && kept.headers === undefined) {
            kept.headers = foldHeaders(kept.entries);
        }
        return kept?.headers;
    }

    /** @returns {string|undefined} */
    get method() {
        return this._route.method ?? this._kept?.method;
    }

    /** @returns {string} */
    get path() {
        const url = this._req === null ? this._kept?.url : this._req.getUrl();
        if (url === undefined) {
            throw new TypeError("req.url and req.path after the handler returned need { url: true } on the route");
        }
        return url;
    }

    /** @returns {string} */
    get url() {
        return this._rawQuery === "" ? this.path : `${this.path}?${this._rawQuery}`;
    }

    /**
     * @param {string} name
     * @returns {string|undefined}
     */
    get(name) {
        const key = name.toLowerCase();
        if (this._req !== null) {
            return this._req.getHeader(key) || undefined;
        }
        const headers = this.headers;
        const kept = this._route.keptHeader;
        if (headers === undefined || (kept !== null && !kept.has(key))) {
            throw new TypeError(`req.get("${key}") after the handler returned needs it in { headers } on the route`);
        }
        return headers[key] || undefined;
    }

    /**
     * @param {string} name
     * @returns {string|undefined}
     */
    header(name) {
        return this.get(name);
    }
}

class LiteResponse {
    /**
     * @param {any} res µWS's
     * @param {LiteRequest} req
     * @param {string} encoding what the route's compressor negotiated
     */
    constructor(res, req, encoding) {
        this._res = res;
        this.req = req;
        this._encoding = encoding;
        /** @type {string|null} */
        this._type = null;
        /** @type {Record<string, string|string[]>|null} */
        this._headers = null;
        this.statusCode = 200;
        this._flags = 0;
        /** @type {any} made on the first listener or write, most answers need neither */
        this._bus = null;
    }

    /** @returns {boolean} */
    get headersSent() {
        return (this._flags & ANSWERED) !== 0;
    }

    /**
     * @param {number} code
     * @returns {this}
     */
    status(code) {
        if (!Number.isInteger(code) || code < 100 || code > 999) {
            throw new RangeError(`Invalid status code: ${JSON.stringify(code)}. Status code must be an integer.`);
        }
        this.statusCode = code;
        return this;
    }

    /**
     * @param {string|Record<string, string|string[]>} field
     * @param {string|string[]} [value]
     * @returns {this}
     */
    set(field, value) {
        if (typeof field === "object") {
            for (const name in field) {
                this.set(name, field[name]);
            }
            return this;
        }
        const name = field.toLowerCase();
        if (name === "content-type") {
            return this._setType(field, value);
        }
        if (name === "content-length") {
            // µWS writes its own, or goes chunked
            return this;
        }
        validateHeaderName(field);
        const out = Array.isArray(value) ? value.map(String) : String(value);
        validateHeaderValue(field, out);
        (this._headers ??= {})[name] = out;
        return this;
    }

    /**
     * @param {string|Record<string, string|string[]>} field
     * @param {string|string[]} [value]
     * @returns {this}
     */
    header(field, value) {
        return this.set(field, value);
    }

    /**
     * @param {string} field
     * @returns {string|string[]|undefined}
     */
    get(field) {
        const name = field.toLowerCase();
        return name === "content-type" ? (this._type ?? undefined) : this._headers?.[name];
    }

    /**
     * @param {string} name
     * @param {string|number|string[]} value
     * @returns {this}
     */
    setHeader(name, value) {
        return this.set(name, /** @type {any} */ (value));
    }

    /**
     * @param {string} name
     * @returns {string|string[]|undefined}
     */
    getHeader(name) {
        return this.get(name);
    }

    /**
     * @param {string} name
     * @returns {boolean}
     */
    hasHeader(name) {
        return this.get(name) !== undefined;
    }

    /** @param {string} name */
    removeHeader(name) {
        const key = name.toLowerCase();
        if (key === "content-type") {
            this._type = null;
        } else if (this._headers !== null) {
            delete this._headers[key];
        }
    }

    /**
     * @param {string} type a mime type or an extension
     * @returns {this}
     */
    type(type) {
        // not through set(): no toLowerCase of a name known here, on nearly every response
        return this._setType("content-type", type.indexOf("/") === -1 ? contentTypeFor(type) : type);
    }

    /**
     * The one header nearly every response sets, and no map for it.
     *
     * @param {string} field the name as written, for the error
     * @param {unknown} value
     * @returns {this}
     */
    _setType(field, value) {
        const type = contentTypeSet(String(value)) || "false";
        // the known ones are already bytes, and end() and a Buffer write it as it is
        if (HEADER_VALUE_BUF[type] === undefined) {
            validateHeaderValue(field, type);
        }
        this._type = type;
        return this;
    }

    /**
     * @param {unknown} [body]
     * @returns {this}
     */
    send(body) {
        if (typeof body === "string") {
            const type = this._type;
            return this._finish(
                type === null ? HTML : type === JSON_UTF8 || type === TEXT ? type : withUtf8Charset(type),
                body
            );
        }
        if (body === undefined || body === null) {
            return this._finish(this._type, "");
        }
        if (body instanceof Uint8Array) {
            return this._finish(this._type ?? OCTET, body);
        }
        if (typeof body === "object" || typeof body === "number" || typeof body === "boolean") {
            return this.json(body);
        }
        throw new TypeError(`res.send() takes no ${typeof body}`);
    }

    /**
     * @param {unknown} body
     * @returns {this}
     */
    json(body) {
        const type = this._type;
        const json = JSON.stringify(body) ?? "";
        return this._finish(type === null || type === JSON_UTF8 ? JSON_UTF8 : withUtf8Charset(type), json);
    }

    /**
     * @param {string|Uint8Array} [body]
     * @returns {this}
     */
    end(body) {
        if (this._bus !== null && this._bus.out !== null) {
            this._bus.out.end(body);
            return this;
        }
        return this._finish(this._type, body ?? "");
    }

    /**
     * Chunked, for stream.pipe(res). What it writes goes through a PassThrough, so compression,
     * backpressure and an abort are the ones of a Readable answered with uwsUtils.
     *
     * @param {string|Uint8Array} chunk
     * @param {any} [encoding]
     * @param {any} [callback]
     * @returns {boolean}
     */
    write(chunk, encoding, callback) {
        const bus = this._emitter();
        if (bus.out === null) {
            this._open(bus);
        }
        return bus.out.write(chunk, encoding, callback);
    }

    /** @param {any} bus */
    _open(bus) {
        const flags = this._flags;
        if ((flags & ANSWERED) !== 0) {
            throw new Error("Cannot set headers after they are sent to the client");
        }
        this._flags = flags | ANSWERED;
        const out = new PassThrough();
        bus.out = out;
        out.on("drain", () => bus.emit("drain"));
        out.on("close", () => streamClosed(this, out));
        if ((flags & ABORTED) !== 0) {
            out.destroy();
            return;
        }
        const type = this._type;
        const compress = this.req._route.compress;
        if (compress !== null && type !== null && compression._isCompressible(type)) {
            compress._deliver(this._res, this.statusCode, this._headers, type, out, this._encoding);
        } else {
            const bytes = type === null ? null : HEADER_VALUE_BUF[type] || /** @type {any} */ (type);
            _respond(this._res, this.statusCode, this._headers, bytes, null, false, out);
        }
    }

    /** @returns {any} */
    _emitter() {
        if (this._bus === null) {
            this._bus = new EventEmitter();
            this._bus.out = null;
        }
        return this._bus;
    }

    /**
     * @param {string} name
     * @param {(...args: any[]) => void} listener
     * @returns {this}
     */
    on(name, listener) {
        this._emitter().on(name, listener);
        return this;
    }

    /**
     * @param {string} name
     * @param {(...args: any[]) => void} listener
     * @returns {this}
     */
    once(name, listener) {
        this._emitter().once(name, listener);
        return this;
    }

    /**
     * @param {string} name
     * @param {(...args: any[]) => void} listener
     * @returns {this}
     */
    removeListener(name, listener) {
        this._bus?.removeListener(name, listener);
        return this;
    }

    /**
     * @param {string} name
     * @param {(...args: any[]) => void} listener
     * @returns {this}
     */
    off(name, listener) {
        return this.removeListener(name, listener);
    }

    /**
     * @param {string} name
     * @param {any[]} args
     * @returns {boolean}
     */
    emit(name, ...args) {
        return this._bus !== null && this._bus.emit(name, ...args);
    }

    /**
     * @param {string} name
     * @returns {number}
     */
    listenerCount(name) {
        return this._bus === null ? 0 : this._bus.listenerCount(name);
    }

    /**
     * @param {number} code
     * @returns {this}
     */
    sendStatus(code) {
        this.status(code);
        return this._finish(TEXT, statusLine(code, undefined).slice(4));
    }

    /**
     * @param {string|null} type
     * @param {string|Uint8Array} body
     * @returns {this}
     */
    _finish(type, body) {
        const flags = this._flags;
        if ((flags & ANSWERED) !== 0) {
            throw new Error("Cannot set headers after they are sent to the client");
        }
        this._flags = flags | ANSWERED;
        if ((flags & ABORTED) !== 0) {
            return this;
        }
        const res = this._res;
        const status = this.statusCode;
        const compress = this.req._route.compress;
        if (status === 204 || status === 304) {
            // no body and no header describing one, as Express
            _respondWhole(res, status, this._headers, null, undefined, (flags & LATE) === 0);
        } else if (compress !== null && type !== null && compression._isCompressible(type)) {
            compress._deliver(res, status, this._headers, type, body, this._encoding);
        } else {
            _respondWhole(res, status, this._headers, type, body, (flags & LATE) === 0);
        }
        if (this._bus !== null) {
            process.nextTick(finished, this._bus);
        }
        return this;
    }

    /**
     * Refuses the request, for what the route does before the handler.
     *
     * @param {number} status
     */
    _refuse(status) {
        this.statusCode = status;
        this._finish(TEXT, statusLine(status, undefined).slice(4));
    }
}

/**
 * What µWS calls on an abort, once the route needs to know.
 *
 * @this {LiteResponse}
 */
function onAborted() {
    this._flags |= ABORTED;
    dropBody(this.req);
    this._bus?.emit("close");
}

/**
 * The client left, so a body as a stream will not end.
 *
 * @param {LiteRequest} request
 */
function dropBody(request) {
    if (request._route.body === "stream") {
        const body = request.body;
        // as node, an error only for who listens
        body.destroy(
            body.listenerCount("error") > 0 ? Object.assign(new Error("aborted"), { code: "ECONNRESET" }) : undefined
        );
    }
}

/** @param {any} bus */
function finished(bus) {
    bus.emit("finish");
    bus.emit("close");
}

/**
 * @param {LiteResponse} response
 * @param {any} out
 */
function streamClosed(response, out) {
    if (out.writableFinished && out.readableEnded) {
        finished(response._bus);
        return;
    }
    // the client left, or the handler failed after the first write
    response._flags |= ABORTED;
    dropBody(response.req);
    response._bus.emit("close");
}

/** While the body arrives: nothing to do on an abort, collectBody just never calls back. */
function bodyAborted() {}

/**
 * @this {LiteResponse}
 * @param {unknown} error
 */
function fail(error) {
    if (process.env.NODE_ENV !== "test") {
        console.error(error);
    }
    this._bus?.out?.destroy(/** @type {Error} */ (error));
    if ((this._flags & ANSWERED) === 0) {
        this._headers = null;
        this._type = null;
        // what next(err) and http-errors say, as Express's final handler
        const status = /** @type {any} */ (error)?.status ?? /** @type {any} */ (error)?.statusCode;
        this._refuse(Number.isInteger(status) && status >= 400 && status < 600 ? status : 500);
    }
}

/**
 * @param {any} res
 * @param {LiteRequest} request
 * @param {LiteResponse} response
 */
function run(res, request, response) {
    let result;
    try {
        result = request._route.handler(request, response);
    } catch (error) {
        fail.call(response, error);
    }
    response._flags |= LATE;
    request._req = null;
    // answers later: this is still before the return µWS wants onAborted by. chain() has its own
    if (request._route.use === null && (response._flags & ANSWERED) === 0) {
        res.onAborted(onAborted.bind(response));
    }
    if (result !== null && typeof result === "object" && typeof result.then === "function") {
        result.then(undefined, fail.bind(response));
    }
}

/**
 * The middleware of the route and then the handler. A chain that calls next before returning stays
 * on µWS's stack. Errors go to the middleware with four parameters, then to fail().
 *
 * @param {any} res
 * @param {LiteRequest} request
 * @param {LiteResponse} response
 */
function chain(res, request, response) {
    const use = request._route.use;
    let index = 0;
    /** @param {unknown} [error] */
    const next = (error) => {
        if ((response._flags & (ANSWERED | ABORTED)) !== 0) {
            return;
        }
        const failing = Boolean(error);
        while (index < use.length) {
            const middleware = use[index++];
            if ((middleware.length === 4) !== failing) {
                continue;
            }
            let result;
            try {
                result = failing ? middleware(error, request, response, next) : middleware(request, response, next);
            } catch (thrown) {
                next(thrown);
                return;
            }
            if (result !== null && typeof result === "object" && typeof result.then === "function") {
                result.then(undefined, next);
            }
            return;
        }
        if (failing) {
            fail.call(response, error);
        } else {
            run(res, request, response);
        }
    };
    next();
    // an abort can only arrive after this returns, so a chain that answered never needs it
    if ((response._flags & ANSWERED) === 0) {
        res.onAborted(onAborted.bind(response));
    }
    response._flags |= LATE;
    request._req = null;
}

/**
 * @param {any} res
 * @param {LiteRequest} request
 * @param {LiteResponse} response
 */
function start(res, request, response) {
    if (request._route.use === null) {
        run(res, request, response);
    } else {
        chain(res, request, response);
    }
}

/**
 * The body as a Readable, with µWS's backpressure.
 *
 * @param {any} res
 * @param {LiteResponse} response
 * @returns {Readable}
 */
function bodyStream(res, response) {
    let paused = false;
    const stream = new Readable({
        read() {
            if (paused && !gone(response)) {
                paused = false;
                res.resume();
            }
        }
    });
    res.onData((/** @type {ArrayBuffer} */ chunk, /** @type {boolean} */ isLast) => {
        // copied, µWS neuters it on return
        const accepted = stream.push(Buffer.from(new Uint8Array(chunk)));
        if (!accepted && !isLast && !gone(response)) {
            paused = true;
            res.pause();
        }
        if (isLast) {
            stream.push(null);
        }
    });
    return stream;
}

/**
 * Whether µWS's res is over: the client left or the whole answer is out.
 *
 * @param {LiteResponse} response
 * @returns {boolean}
 */
function gone(response) {
    const flags = response._flags;
    if ((flags & ABORTED) !== 0) {
        return true;
    }
    if ((flags & ANSWERED) === 0) {
        return false;
    }
    const out = response._bus?.out;
    return out === null || out === undefined || out.destroyed;
}

/**
 * What res.collectBody() calls with the whole body. null is over the limit.
 *
 * @this {LiteResponse}
 * @param {ArrayBuffer|null} body
 */
function onBody(body) {
    const response = this;
    if (body === null) {
        response._refuse(413);
        return;
    }
    const request = response.req;
    const format = request._route.body;
    if (format === "text") {
        request.body = UTF8.decode(body);
    } else if (format === "buffer") {
        // copied, a Buffer from express.raw() can be kept and µWS neuters this one on return
        request.body = Buffer.from(new Uint8Array(body));
    } else if (format === "lent") {
        // µWS's memory, as req: for a handler that is done with it before returning
        request.body = Buffer.from(body);
    } else if (format === "form") {
        request.body = parseQuery(UTF8.decode(body));
    } else if (body.byteLength === 0) {
        request.body = {};
    } else {
        let parsed;
        try {
            parsed = JSON.parse(UTF8.decode(body));
        } catch {
            response._refuse(400);
            return;
        }
        // express.json() is strict
        if (typeof parsed !== "object" || parsed === null) {
            response._refuse(400);
            return;
        }
        request.body = parsed;
    }
    start(response._res, request, response);
}

/**
 * The parameters of the path, decoded as Express decodes them. By name, an index moves with the
 * parameters of a mount.
 *
 * @param {any} req
 * @param {string[]} names
 * @returns {Record<string, string>|null} null when one does not decode
 */
function readParams(req, names) {
    /** @type {any} */
    const params = { __proto__: null };
    for (let i = 0; i < names.length; i++) {
        const name = names[i];
        const value = req.getParameter(name);
        if (value.indexOf("%") === -1) {
            params[name] = value;
            continue;
        }
        try {
            params[name] = decodeURIComponent(value);
        } catch {
            return null;
        }
    }
    return params;
}

// where collectHeader writes: forEach is synchronous, so one function and one array serve every
// request, as in Request
/** @type {string[]} */
const collected = [];
let collectedCount = 0;

/**
 * @param {string} name
 * @param {string} value
 */
const collectHeader = (name, value) => {
    collected[collectedCount++] = name;
    collected[collectedCount++] = value;
};

/**
 * Middleware reads headers before and after an await, and µWS's req does not last. Flat, the object
 * is made only if someone reads it after that.
 *
 * @param {any} req
 * @returns {string[]} name, value, name, value
 */
function allHeaders(req) {
    collectedCount = 0;
    req.forEach(collectHeader);
    return collected.slice(0, collectedCount);
}

/**
 * @param {string[]} entries what allHeaders() kept
 * @returns {Record<string, string>}
 */
function foldHeaders(entries) {
    /** @type {any} */
    const headers = { __proto__: null };
    for (let i = 0; i < entries.length; i += 2) {
        const name = entries[i];
        const seen = headers[name];
        headers[name] =
            seen === undefined ? entries[i + 1] : `${seen}${name === "cookie" ? "; " : ", "}${entries[i + 1]}`;
    }
    return headers;
}

/**
 * What the route declared it reads after req is gone.
 *
 * @param {any} route
 * @param {any} req
 * @returns {{url?: string, method?: string, headers?: Record<string, string>, entries?: string[]}}
 */
function keep(route, req) {
    /** @type {{url?: string, method?: string, headers?: Record<string, string>, entries?: string[]}} */
    const kept = {};
    if (route.keepUrl) {
        kept.url = req.getUrl();
    }
    if (route.method === null) {
        kept.method = req.getCaseSensitiveMethod();
    }
    if (route.keepAll) {
        kept.entries = allHeaders(req);
    } else if (route.keepHeaders !== null) {
        /** @type {Record<string, string>} */
        const headers = {};
        for (const name of route.keepHeaders) {
            headers[name] = req.getHeader(name);
        }
        kept.headers = headers;
    }
    return kept;
}

/**
 * @param {string} method the method of app.uws()
 * @param {string} path a µWS pattern
 * @param {LiteOptions} options
 * @param {(req: any, res: any) => unknown} handler
 * @returns {{uws: (res: any, req: any) => void, express: any[], verb: string}}
 */
function makeLiteRoute(method, path, options, handler) {
    if (typeof handler !== "function") {
        throw new TypeError("app.uwsLite() requires a handler function");
    }
    if (path.includes("*")) {
        throw new TypeError("app.uwsLite() takes no * in the path: use app.uws() or an Express route");
    }
    const lower = String(method).toLowerCase();
    const any = lower === "any" || lower === "all";
    const format = options.body;
    if (format !== undefined && !["text", "json", "form", "buffer", "lent", "stream"].includes(format)) {
        throw new TypeError(
            `app.uwsLite() option body must be text, json, form, buffer, lent or stream, got ${String(format)}`
        );
    }
    if (format === "stream" && options.limit !== undefined) {
        throw new TypeError('app.uwsLite() takes no limit with body: "stream", the handler reads it as it arrives');
    }
    const use = options.use ?? [];
    if (!Array.isArray(use) || use.some((middleware) => typeof middleware !== "function")) {
        throw new TypeError("app.uwsLite() option use must be an array of functions");
    }
    if (use.length !== 0 && format === "lent") {
        throw new TypeError('app.uwsLite() takes no use with body: "lent", middleware can outlive the lent memory');
    }
    const limit = options.limit === undefined ? DEFAULT_LIMIT : bytes.parse(options.limit);
    if (limit === null) {
        throw new TypeError(`option limit "${String(options.limit)}" is invalid`);
    }
    const names = path
        .split("/")
        .filter((segment) => segment.startsWith(":"))
        .map((segment) => segment.slice(1));
    const wantedHeaders = options.headers === undefined ? false : options.headers;
    if (typeof wantedHeaders !== "boolean" && !Array.isArray(wantedHeaders)) {
        throw new TypeError("app.uwsLite() option headers must be an array of names, true for all of them, or false");
    }
    const headers = Array.isArray(wantedHeaders) ? wantedHeaders.map((name) => name.toLowerCase()) : null;
    const keepAll = wantedHeaders === true || use.length !== 0;
    // true is the defaults, false or nothing is off
    const wanted = options.compress === undefined ? false : options.compress;
    if (typeof wanted !== "boolean" && (typeof wanted !== "object" || wanted === null)) {
        throw new TypeError("app.uwsLite() option compress must be true, false or what express.compression() takes");
    }
    const settings = wanted === true ? {} : wanted;
    const compress = settings === false ? null : compressor(settings);
    const route = {
        handler,
        body: format ?? null,
        compress,
        method: any ? null : lower === "del" ? "DELETE" : lower.toUpperCase(),
        use: use.length === 0 ? null : use,
        keepUrl: options.url === true || use.length !== 0,
        keepAll,
        keepHeaders: headers,
        // null: all of them are kept
        keptHeader: keepAll ? null : new Set(headers)
    };
    const hasParams = names.length !== 0;
    const keeps = any || route.keepUrl || keepAll || headers !== null;
    const streamed = format === "stream";

    /** @type {(res: any, req: any) => void} */
    const uws = (res, req) => {
        const rawQuery = req.getQuery();
        const params = hasParams ? readParams(req, names) : NO_PARAMS;
        const encoding = compress === null ? "" : compress.negotiate(req);
        const request = new LiteRequest(req, route, rawQuery, params ?? NO_PARAMS, keeps ? keep(route, req) : null);
        const response = new LiteResponse(res, request, encoding);
        if (params === null) {
            response._refuse(400);
        } else if (format === undefined) {
            start(res, request, response);
        } else if (streamed) {
            request.body = bodyStream(res, response);
            start(res, request, response);
        } else {
            request._req = null;
            res.onAborted(bodyAborted);
            res.collectBody(limit, onBody.bind(response));
        }
    };

    // the same handler where µWS is not in front: HTTP/2, createServer, a HEAD, a path µWS's exact
    // match let through
    const before = [];
    if (settings !== false) {
        before.push(compression(settings));
    }
    if (streamed) {
        before.push((/** @type {any} */ req, /** @type {any} */ _res, /** @type {any} */ next) => {
            req.body = req;
            next();
        });
    } else if (format !== undefined) {
        const parsers = {
            text: bodyParser.text,
            json: bodyParser.json,
            form: bodyParser.urlencoded,
            buffer: bodyParser.raw,
            lent: bodyParser.raw
        };
        before.push(parsers[format]({ type: () => true, limit }));
    }
    return { uws, express: [...before, ...use, handler], verb: any ? "all" : lower === "del" ? "delete" : lower };
}

module.exports = { makeLiteRoute };
