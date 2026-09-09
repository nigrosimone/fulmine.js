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

// events is faster at init, tseep is faster at sending events
// since we create a ton of objects and dont send a ton of events, its better to use events here
const { EventEmitter } = require("events");
const { kShapeMode } = require("./response-utils.js");

class Socket extends EventEmitter {
    /**
     * The Socket's error listener, shared across sockets: an error closes the stand-in, which is
     * the close connection trackers wait for. EventEmitter calls it with this = the emitter.
     *
     * @this {any}
     * @param {any} err
     */
    static _onError(err) {
        this.emit("close");
    }

    /**
     * Enough of a node socket for the middleware that reaches for one. uWS has no socket object to
     * hand over, so this stands in and forwards what it can to the response.
     *
     * @param {any} response
     */
    constructor(response) {
        super();
        this.response = response;
        this[kShapeMode] = true;
        // middleware assigns to this one, which is why it is a field rather than a getter: express
        // reads socket.encrypted for req.protocol and a proxy shim writes it
        this.encrypted = response.req.app.ssl;
        this.localPort = response.req.app.port;
        // on-finished reads socket.readable before anything else, and a socket without one reads
        // as a request that is already over
        this.readable = true;

        // shared, not an arrow: one per process instead of one per materialized socket
        this.on("error", Socket._onError);
    }

    /** Whether anything more can be written, which stops being true once the response is done. */
    get writable() {
        return !this.response.finished;
    }

    /** The peer, as node reports it. Reading it out of uWS is slow, so the request caches it. */
    get remoteAddress() {
        return this.response.req.parsedIp;
    }

    /** A native µWS call almost no caller makes, so it stays behind its getter. */
    get remotePort() {
        return this.response.req._res.getRemotePort();
    }

    /**
     * node's socket carries these three, usually called to take the timeout off. uWS has no per
     * socket timeout reachable from javascript, so they do nothing and return the socket. n8n's
     * chat trigger calls setTimeout on every webhook, and without it the workflow answered 500.
     * @returns {this}
     */
    setTimeout() {
        return this;
    }

    /** @returns {this} */
    setKeepAlive() {
        return this;
    }

    /** @returns {this} */
    setNoDelay() {
        return this;
    }

    /**
     * Finishes the response through the socket, which is how the middleware that only knows
     * about sockets ends one.
     * @param {any} [body]
     */
    end(body) {
        this.response.end(body);
    }

    /**
     * What a server side socket answers about itself. uWS owns the connection, so these follow the
     * response.
     */
    get destroyed() {
        return this.response.finished === true;
    }

    /** @returns {string} "open" until the response is over, as a served socket reads. */
    get readyState() {
        return this.response.finished === true ? "closed" : "open";
    }

    /** @returns {boolean} never: this end was accepted, not dialled. */
    get connecting() {
        return false;
    }

    /** @returns {boolean} never, for the same reason. */
    get pending() {
        return false;
    }

    /**
     * The end of the connection node reports here. There is no address to read back from uWS, so
     * this is the port the application bound and the family the peer arrived on.
     * @returns {{address: string|undefined, family: string, port: number|undefined}}
     */
    address() {
        const remote = this.response.req.parsedIp;
        return {
            address: this.response.req.app._listenHost,
            family: remote?.includes(":") ? "IPv6" : "IPv4",
            port: this.localPort
        };
    }

    /**
     * Drops the connection. node takes an error and re-emits it, this closes and says so through
     * 'close', since there is no socket underneath to carry an error of its own.
     * @returns {this}
     */
    destroy() {
        this.close();
        return this;
    }

    /** @returns {this} */
    destroySoon() {
        this.close();
        return this;
    }

    /**
     * Holds and resumes the body arriving on this connection. The other half of node's pause()
     * means nothing here, the response is written when the application writes it.
     * @returns {this}
     */
    pause() {
        this.response.req.pause();
        return this;
    }

    /** @returns {this} */
    resume() {
        this.response.req.resume();
        return this;
    }

    /**
     * node writes these bytes straight onto the connection. There is no way past uWS's framing
     * here, so they go through the response instead.
     *
     * @param {any} chunk
     * @param {any} [encoding]
     * @param {any} [callback]
     * @returns {boolean}
     */
    write(chunk, encoding, callback) {
        return this.response.write(chunk, encoding, callback);
    }

    /** The event loop is µWS's, so there is nothing to hold open or let go. @returns {this} */
    ref() {
        return this;
    }

    /** @returns {this} */
    unref() {
        return this;
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

module.exports = Socket;
