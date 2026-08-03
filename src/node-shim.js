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

// A uWS-shaped request and response backed by node's own, so an app can serve what arrived through
// http.createServer. Nothing on this path is fast, and it is not meant to be: it is what lets
// supertest and http.createServer(app) work, which is what an app has to be a function for.
//
// Request and Response ask uWS for eighteen things and this answers all eighteen. Where the two
// models disagree node's gives way: cork only runs its callback, and a status is remembered rather
// than sent, since node writes the head with the first byte of body.

const { IncomingMessage } = require("http");

/**
 * An IP address as the four or sixteen bytes uWS hands over, since that is what req.ip parses.
 * Anything unreadable comes back empty, which req.ip reports as undefined, the same answer it gives
 * for a unix socket.
 *
 * @param {string|undefined} address
 * @returns {ArrayBuffer}
 */
function addressToBytes(address) {
    if (!address) {
        return new ArrayBuffer(0);
    }
    // node reports an IPv4 client on a dual stack socket as ::ffff:127.0.0.1, and the address that
    // belongs in req.ip is the v4 one
    const mapped = address.startsWith("::ffff:") ? address.slice(7) : address;
    if (mapped.includes(".")) {
        const parts = mapped.split(".");
        if (parts.length !== 4) {
            return new ArrayBuffer(0);
        }
        const bytes = new Uint8Array(4);
        for (let i = 0; i < 4; i++) {
            const value = Number(parts[i]);
            if (!Number.isInteger(value) || value < 0 || value > 255) {
                return new ArrayBuffer(0);
            }
            bytes[i] = value;
        }
        return bytes.buffer;
    }

    // IPv6, with the one "::" expanded to however many zero groups are missing
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

/** A chunk as the ArrayBuffer uWS deals in, copied rather than viewed so nothing aliases node's. */
function toArrayBuffer(chunk) {
    if (chunk instanceof ArrayBuffer) {
        return chunk;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/**
 * What uWS calls an HttpRequest, over node's IncomingMessage.
 *
 * Only valid for as long as the response is, which here is longer than uWS allows: node keeps the
 * headers alive, so nothing has to be copied out in a hurry. Request copies them anyway, since it
 * cannot tell which kind of request it is holding.
 */
class NodeHttpRequest {
    /** @param {import("http").IncomingMessage} req */
    constructor(req) {
        this._req = req;
        const url = req.url || "/";
        const question = url.indexOf("?");
        this._path = question === -1 ? url : url.slice(0, question);
        // uWS answers the query without its "?", and an empty string when there is none
        this._query = question === -1 ? "" : url.slice(question + 1);
    }

    /** The path, without the query, which is what uWS answers here. */
    getUrl() {
        return this._path;
    }

    /** The query string without its "?", empty when there is none, as uWS reports it. */
    getQuery() {
        return this._query;
    }

    /** The method as it arrived on the wire. */
    getCaseSensitiveMethod() {
        return this._req.method || "GET";
    }

    /** The method lowercased, which is the other spelling uWS offers. */
    getMethod() {
        return (this._req.method || "GET").toLowerCase();
    }

    /**
     * Every header, lowercased, in the order they arrived. rawHeaders and not headers, because the
     * object node builds has already joined the repeated ones together.
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

    /**
     * There are no natively registered routes on this path, so nothing ever asks. Answering the
     * empty string rather than throwing keeps a stray caller from taking the app down.
     */
    getParameter() {
        return "";
    }
}

/**
 * What uWS calls an HttpResponse, over node's ServerResponse.
 *
 * The status and the headers are held until node writes the head on its own, which it does when the
 * first byte of body goes out. That is why writeStatus only remembers: sending it here would send
 * the headers too, before the ones still to come had been set.
 */
class NodeHttpResponse {
    /**
     * @param {import("http").IncomingMessage} req
     * @param {import("http").ServerResponse} res
     */
    constructor(req, res) {
        this._nodeReq = req;
        this._nodeRes = res;
        // how much of the body has gone out, which is what uWS reports through getWriteOffset and
        // hands back to an onWritable callback
        this._offset = 0;
        this._onWritable = null;
        this._aborted = false;
        // the current body handler: uWS keeps one and a second onData replaces it, so this does too
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
     * uWS batches everything written inside this into one syscall. node has no equivalent that
     * means the same thing, and its own cork would hold the write until the callback returned
     * without changing what is sent, so this only runs it.
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
     * uWS writes a header line per call and never replaces one, which is what the code above this
     * is written against: two calls for Set-Cookie are two cookies. setHeader would have kept only
     * the last, and did, until supertest started serving applications through node's own server.
     *
     * @param {string} key
     * @param {string|number} value
     */
    writeHeader(key, value) {
        if (!this._nodeRes.headersSent) {
            this._nodeRes.appendHeader(key, String(value));
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
     * A response with a length but no body of its own: a HEAD, or a status that carries none. uWS
     * takes the length here rather than as a header, so it is written as one on the way through.
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
     * Writes a chunk of a response whose total length is known. Answers uWS's pair: whether the
     * write got through, and whether that was the last of it.
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
     * Called when there is room to write again. uWS asks the handler to answer whether it managed
     * to write everything, and calls it again if not; node's drain says nothing, so the handler is
     * kept until the next drain and its answer ignored.
     */
    onWritable(handler) {
        this._onWritable = handler;
        return this;
    }

    /** Called when the connection goes before the response is finished. */
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
     * The body, in the chunks node hands over, as the ArrayBuffer and last-chunk flag uWS delivers.
     * A second call replaces the handler, as uWS does: the body parsers rely on that, and a chunk
     * held back before they attached has to reach them rather than the handler it arrived under.
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
            // uWS marks the last chunk rather than announcing the end separately, so the one in
            // hand is held back until there is nothing after it
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

    /** The client address as the bytes uWS hands over, which is what req.ip parses. */
    getRemoteAddress() {
        return addressToBytes(this._nodeReq.socket?.remoteAddress);
    }

    /** The client address as text, which uWS also offers. */
    getRemoteAddressAsText() {
        return Buffer.from(this._nodeReq.socket?.remoteAddress || "");
    }

    /** The client port, or 0 when the socket has already gone. */
    getRemotePort() {
        return this._nodeReq.socket?.remotePort ?? 0;
    }
}

/**
 * Whether these are node's own request and response rather than this project's.
 * @param {any} req
 */
function isNodeRequest(req) {
    return req instanceof IncomingMessage;
}

/**
 * Serves a request that arrived through node's HTTP server with the given router or app.
 *
 * @param {any} router
 * @param {import("http").IncomingMessage} nodeReq
 * @param {import("http").ServerResponse} nodeRes
 * @param {(err?: any) => void} [next] called when nothing in the router answered
 */
function serveNodeRequest(router, nodeReq, nodeRes, next) {
    const shimRes = new NodeHttpResponse(nodeReq, nodeRes);
    const shimReq = new NodeHttpRequest(nodeReq);
    const { request, response } = router.handleRequest(shimRes, shimReq);

    return router._routeRequest(request, response).then((matched) => {
        if (matched || response.headersSent || response.aborted) {
            return;
        }
        if (next) {
            return next(request._error);
        }
        router._endUnmatched(request, response);
    });
}

module.exports = { NodeHttpRequest, NodeHttpResponse, isNodeRequest, serveNodeRequest, addressToBytes };
