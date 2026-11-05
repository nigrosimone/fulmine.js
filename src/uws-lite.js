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
const bytes = require("bytes");
const bodyParser = require("./body-parser.js");
const compression = require("./compression.js");
const parseQuery = require("./parse-query.js");
const { HEADER_VALUE_BUF, statusLine } = require("./response-utils.js");
const { compressor, _respondWhole } = require("./uws-utils.js");
const {
    contentTypeFor,
    contentTypeSet,
    validateHeaderName,
    validateHeaderValue,
    withUtf8Charset
} = require("./utils.js");

/**
 * @typedef {{
 *   body?: "text"|"json"|"form"|"buffer"|"lent",
 *   limit?: number|string,
 *   compress?: any,
 *   headers?: string[],
 *   url?: boolean
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
     * @param {{url?: string, method?: string, headers?: Record<string, string>}|null} kept
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
        const headers = this._kept?.headers;
        if (headers === undefined || !this._route.keptHeader.has(key)) {
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
            // the one nearly every response sets, and no map for it
            const type = contentTypeSet(String(value)) || "false";
            // the known ones are already bytes, and end() and a Buffer write it as it is
            if (HEADER_VALUE_BUF[type] === undefined) {
                validateHeaderValue(field, type);
            }
            this._type = type;
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
     * @param {string} type a mime type or an extension
     * @returns {this}
     */
    type(type) {
        return this.set("content-type", type.indexOf("/") === -1 ? contentTypeFor(type) : type);
    }

    /**
     * @param {unknown} [body]
     * @returns {this}
     */
    send(body) {
        if (typeof body === "string") {
            const type = this._type;
            return this._finish(type === null ? HTML : type === JSON_UTF8 ? type : withUtf8Charset(type), body);
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
        return this._finish(this._type, body ?? "");
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
    if ((this._flags & ANSWERED) === 0) {
        this._headers = null;
        this._type = null;
        this._refuse(500);
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
    if ((response._flags & ANSWERED) === 0) {
        // answers later: this is still before the return µWS wants onAborted by
        res.onAborted(onAborted.bind(response));
    }
    if (result !== null && typeof result === "object" && typeof result.then === "function") {
        result.then(undefined, fail.bind(response));
    }
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
    run(response._res, request, response);
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

/**
 * What the route declared it reads after req is gone.
 *
 * @param {any} route
 * @param {any} req
 * @returns {{url?: string, method?: string, headers?: Record<string, string>}}
 */
function keep(route, req) {
    /** @type {{url?: string, method?: string, headers?: Record<string, string>}} */
    const kept = {};
    if (route.keepUrl) {
        kept.url = req.getUrl();
    }
    if (route.method === null) {
        kept.method = req.getCaseSensitiveMethod();
    }
    if (route.keepHeaders !== null) {
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
    if (format !== undefined && !["text", "json", "form", "buffer", "lent"].includes(format)) {
        throw new TypeError(
            `app.uwsLite() option body must be text, json, form, buffer or lent, got ${String(format)}`
        );
    }
    const limit = options.limit === undefined ? DEFAULT_LIMIT : bytes.parse(options.limit);
    if (limit === null) {
        throw new TypeError(`option limit "${String(options.limit)}" is invalid`);
    }
    const names = path
        .split("/")
        .filter((segment) => segment.startsWith(":"))
        .map((segment) => segment.slice(1));
    const headers = options.headers?.map((name) => name.toLowerCase()) ?? null;
    const compress = options.compress === undefined ? null : compressor(options.compress);
    const route = {
        handler,
        body: format ?? null,
        compress,
        method: any ? null : lower === "del" ? "DELETE" : lower.toUpperCase(),
        keepUrl: options.url === true,
        keepHeaders: headers,
        keptHeader: new Set(headers)
    };
    const hasParams = names.length !== 0;
    const keeps = any || route.keepUrl || headers !== null;

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
            run(res, request, response);
        } else {
            request._req = null;
            res.onAborted(bodyAborted);
            res.collectBody(limit, onBody.bind(response));
        }
    };

    // the same handler where µWS is not in front: HTTP/2, createServer, a HEAD, a path µWS's exact
    // match let through
    const before = [];
    if (options.compress !== undefined) {
        before.push(compression(options.compress));
    }
    if (format !== undefined) {
        const parsers = {
            text: bodyParser.text,
            json: bodyParser.json,
            form: bodyParser.urlencoded,
            buffer: bodyParser.raw,
            lent: bodyParser.raw
        };
        before.push(parsers[format]({ type: () => true, limit }));
    }
    return { uws, express: [...before, handler], verb: any ? "all" : lower === "del" ? "delete" : lower };
}

module.exports = { makeLiteRoute };
