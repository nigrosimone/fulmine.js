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

// A uWS-shaped request and response over node's own, for supertest and http.createServer(app).
// Not fast and not meant to be. Where the models disagree node's gives way: cork only runs its
// callback, a status is kept until the first byte of body

const { IncomingMessage } = require("http");

/** What µWS returns for an address nobody declared. */
const emptyAddress = new ArrayBuffer(0);

/**
 * An IP address as the four or sixteen bytes uWS hands over; unreadable comes back empty.
 *
 * @param {string|undefined} address
 * @returns {ArrayBuffer}
 */
function addressToBytes(address) {
    if (!address) {
        return new ArrayBuffer(0);
    }
    // ::ffff:127.0.0.1 as sixteen bytes and 127.0.0.1 as four, so req.ip reads back node's own form
    const mapped = address.startsWith("::ffff:") && address.includes(".");
    const dotted = mapped ? address.slice(7) : address;
    if (dotted.includes(".")) {
        const parts = dotted.split(".");
        if (parts.length !== 4) {
            return new ArrayBuffer(0);
        }
        const bytes = new Uint8Array(mapped ? 16 : 4);
        const offset = mapped ? 12 : 0;
        if (mapped) {
            bytes[10] = 0xff;
            bytes[11] = 0xff;
        }
        for (let i = 0; i < 4; i++) {
            const value = Number(parts[i]);
            if (!Number.isInteger(value) || value < 0 || value > 255) {
                return new ArrayBuffer(0);
            }
            bytes[offset + i] = value;
        }
        return bytes.buffer;
    }

    // IPv6, "::" expanded
    const [head, tail] = address.split("::");
    const headGroups = head ? head.split(":") : [];
    const tailGroups = tail ? tail.split(":") : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0 || (address.includes("::") === false && headGroups.length !== 8)) {
        return new ArrayBuffer(0);
    }
    const groups = address.includes("::")
        ? [...headGroups, ...new Array(missing).fill("0"), ...tailGroups]
        : headGroups;
    const view = new DataView(new ArrayBuffer(16));
    for (let i = 0; i < 8; i++) {
        const value = parseInt(groups[i] || "0", 16);
        if (Number.isNaN(value)) {
            return new ArrayBuffer(0);
        }
        view.setUint16(i * 2, value);
    }
    return view.buffer;
}

/**
 * A chunk as the ArrayBuffer uWS deals in, copied rather than viewed so nothing aliases node's.
 *
 * @param {ArrayBuffer|Buffer|string} chunk
 * @returns {ArrayBuffer}
 */
function toArrayBuffer(chunk) {
    if (chunk instanceof ArrayBuffer) {
        return chunk;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    return /** @type {ArrayBuffer} */ (buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

/** uWS's HttpRequest over node's IncomingMessage. */
class NodeHttpRequest {
    /** @param {import("http").IncomingMessage} req */
    constructor(req) {
        this._req = req;
        const url = req.url || "/";
        const question = url.indexOf("?");
        this._path = question === -1 ? url : url.slice(0, question);
        // undefined with no "?", "" with an empty query, as uWS answers
        /** @type {string|undefined} */
        this._query = question === -1 ? undefined : url.slice(question + 1);
    }

    /**
     *
     */
    getUrl() {
        return this._path;
    }

    /**
     *
     */
    getQuery() {
        return this._query;
    }

    /**
     *
     */
    getCaseSensitiveMethod() {
        return this._req.method || "GET";
    }

    /**
     *
     */
    getMethod() {
        return (this._req.method || "GET").toLowerCase();
    }

    /**
     * Every header lowercased in arrival order, off rawHeaders since headers joined the repeats.
     * @param {(key: string, value: string) => void} cb
     */
    forEach(cb) {
        const raw = this._req.rawHeaders;
        for (let i = 0; i < raw.length; i += 2) {
            cb(raw[i].toLowerCase(), raw[i + 1]);
        }
    }

    /** @param {string} name */
    getHeader(name) {
        const value = this._req.headers[name];
        if (value === undefined) {
            return "";
        }
        return Array.isArray(value) ? value.join(", ") : value;
    }

    /** No native route exists on this path, so nothing asks. */
    getParameter() {
        return "";
    }
}

/**
 * uWS's HttpResponse over node's ServerResponse: the status and headers are held until node
 * writes the head with the first byte of body.
 */
class NodeHttpResponse {
    /**
     * @param {import("http").IncomingMessage} req
     * @param {import("http").ServerResponse} res
     */
    constructor(req, res) {
        this._nodeReq = req;
        this._nodeRes = res;
        this._offset = 0;
        /** @type {((offset: number) => boolean)|null} */
        this._onWritable = null;
        this._aborted = false;
        // a second onData replaces the handler, as uWS does
        this._onData = null;
        this._onDataPending = null;
        this._onDataListening = false;

        res.on("drain", () => {
            const handler = this._onWritable;
            if (handler) {
                this._onWritable = null;
                handler(this._offset);
            }
        });
    }

    /**
     * Only runs the callback: node's cork would change nothing on the wire.
     *
     * @param {() => void} cb
     */
    cork(cb) {
        cb();
    }

    /** @param {string} status "200 OK", as uWS takes it */
    writeStatus(status) {
        const space = status.indexOf(" ");
        this._nodeRes.statusCode = parseInt(space === -1 ? status : status.slice(0, space), 10);
        if (space !== -1) {
            this._nodeRes.statusMessage = status.slice(space + 1);
        }
        return this;
    }

    /**
     * A header line per call as uWS writes it: two calls for Set-Cookie are two cookies.
     *
     * @param {string} key
     * @param {string|number} value
     */
    writeHeader(key, value) {
        if (!this._nodeRes.headersSent) {
            // writeHeaders hands the recurring names and values over as Buffers
            this._nodeRes.appendHeader(String(key), String(value));
        }
        return this;
    }

    /** @param {ArrayBuffer|Buffer|string} chunk @returns {boolean} false when the socket is full */
    write(chunk) {
        const buffer = Buffer.from(toArrayBuffer(chunk));
        this._offset += buffer.length;
        return this._nodeRes.write(buffer);
    }

    /** @param {ArrayBuffer|Buffer|string} [body] */
    end(body) {
        if (this._aborted) {
            return this;
        }
        if (body === undefined || body === null || body === "") {
            this._nodeRes.end();
            return this;
        }
        const buffer = Buffer.from(toArrayBuffer(body));
        this._offset += buffer.length;
        this._nodeRes.end(buffer);
        return this;
    }

    /**
     * A response with a length and no body, a HEAD or a bodiless status.
     *
     * @param {string|number} [length]
     */
    endWithoutBody(length) {
        if (this._aborted) {
            return this;
        }
        if (length !== undefined && !this._nodeRes.headersSent) {
            this._nodeRes.setHeader("Content-Length", String(length));
        }
        this._nodeRes.end();
        return this;
    }

    /**
     * Writes a chunk of a response whose length is known: uWS's [ok, done] pair.
     *
     * @param {ArrayBuffer|Buffer} chunk
     * @param {number} totalSize
     * @returns {[boolean, boolean]}
     */
    tryEnd(chunk, totalSize) {
        if (this._aborted) {
            return [false, true];
        }
        if (!this._nodeRes.headersSent && !this._nodeRes.hasHeader("Content-Length")) {
            this._nodeRes.setHeader("Content-Length", String(totalSize));
        }
        const buffer = Buffer.from(toArrayBuffer(chunk));
        const ok = this._nodeRes.write(buffer);
        this._offset += buffer.length;
        const done = this._offset >= totalSize;
        if (done) {
            this._nodeRes.end();
        }
        return [ok, done];
    }

    /** How many bytes of the body have gone out. */
    getWriteOffset() {
        return this._offset;
    }

    /**
     * Called when there is room to write again; node's drain ignores the handler's answer.
     *
     * @param {(offset: number) => boolean} handler
     */
    onWritable(handler) {
        this._onWritable = handler;
        return this;
    }

    /**
     * Called when the connection goes before the response is finished.
     *
     * @param {() => void} handler
     */
    onAborted(handler) {
        this._nodeRes.on("close", () => {
            if (!this._nodeRes.writableFinished) {
                this._aborted = true;
                handler();
            }
        });
        return this;
    }

    /**
     * The body as uWS delivers it, an ArrayBuffer and a last-chunk flag. A second call replaces
     * the handler, as uWS does and the body parsers rely on.
     * @param {(chunk: ArrayBuffer, isLast: boolean) => void} handler
     */
    onData(handler) {
        this._onData = handler;
        if (this._onDataListening) {
            return this;
        }
        this._onDataListening = true;
        this._nodeReq.on("data", (chunk) => {
            if (this._onDataPending !== null) {
                this._onData?.(this._onDataPending, false);
            }
            this._onDataPending = toArrayBuffer(chunk);
        });
        this._nodeReq.on("end", () => {
            // uWS marks the last chunk, so the one in hand is held back until the end
            this._onData?.(this._onDataPending ?? new ArrayBuffer(0), true);
            this._onDataPending = null;
        });
        return this;
    }

    /** Stops reading the body, which is how backpressure reaches the client. */
    pause() {
        this._nodeReq.pause();
        return this;
    }

    /** Starts reading the body again. */
    resume() {
        this._nodeReq.resume();
        return this;
    }

    /** Drops the connection without finishing a response. */
    close() {
        this._aborted = true;
        this._nodeRes.destroy();
        return this;
    }

    /**
     *
     */
    getRemoteAddress() {
        return addressToBytes(this._nodeReq.socket?.remoteAddress);
    }

    /**
     *
     */
    getRemoteAddressAsText() {
        return Buffer.from(this._nodeReq.socket?.remoteAddress || "");
    }

    /** Always empty: node's server does not read the PROXY protocol. */
    getProxiedRemoteAddress() {
        return emptyAddress;
    }

    /** The client port, or 0 when the socket has already gone. */
    getRemotePort() {
        return this._nodeReq.socket?.remotePort ?? 0;
    }
}

/**
 * Whether this is node's own request rather than this project's.
 * @param {unknown} req
 */
function isNodeRequest(req) {
    return req instanceof IncomingMessage;
}

/**
 * Serves a request that arrived through node's HTTP server with the given router or app.
 *
 * @param {import("./router.js")} router the router or application serving this request
 * @param {import("http").IncomingMessage} nodeReq
 * @param {import("http").ServerResponse} nodeRes
 * @param {(err?: unknown) => void} [next] called when nothing in the router answered
 */
function serveNodeRequest(router, nodeReq, nodeRes, next) {
    const shimRes = /** @type {import("uWebSockets.js").HttpResponse} */ (
        /** @type {unknown} */ (new NodeHttpResponse(nodeReq, nodeRes))
    );
    const shimReq = /** @type {import("uWebSockets.js").HttpRequest} */ (
        /** @type {unknown} */ (new NodeHttpRequest(nodeReq))
    );
    const request = router.handleRequest(shimRes, shimReq);
    const response = request.res;
    router._armAbort(shimRes, response);

    return router._routeRequest(request, response).then((matched) => {
        // the same rule as nativeDone in router-utils.js
        if (matched || response.aborted || (response.headersSent && !request._error)) {
            return;
        }
        if (next) {
            return next(request._error);
        }
        router._endUnmatched(request, response);
    });
}

module.exports = { NodeHttpRequest, NodeHttpResponse, isNodeRequest, serveNodeRequest, addressToBytes };
