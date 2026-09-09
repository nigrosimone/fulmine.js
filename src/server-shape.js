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

// What makes an application answer the questions a library asks about an http.Server.
//
// `app.listen()` returns the app and there is no node server under it, the socket belongs to uWS.
// Graceful shutdown libraries, connection trackers and health check wrappers recognise a server
// with `server instanceof http.Server`, then call close(), address(), getConnections().
//
// Two halves:
//
//   - the members. close(), address(), listening and the events are already on the application,
//     because Express hands back an http.Server. The rest of net.Server is added below.
//   - the recognition. An application cannot inherit from http.Server, its prototype chain runs
//     through Router and this project's own EventEmitter. So instanceof is taught instead, with
//     Symbol.hasInstance. The patch is additive, nothing loses the answer it had.
//
// Nothing emits 'request', 'connection' or 'upgrade': those carry node sockets and there are none.
// A library counting connections through them counts zero, and socket.io wants app.uwsApp.

const http = require("http");
const net = require("net");

// what marks an application, read by the instanceof hook below. A symbol, so no plain field name
// can be mistaken for it
const kIsApplication = Symbol.for("fulmine.application");

/**
 * Teaches `instanceof` that an application is a server, once per class. The original answer is
 * asked first and never overruled.
 *
 * @param {Function} klass http.Server or net.Server
 */
function acceptApplications(klass) {
    const previous = /** @type {any} */ (klass)[Symbol.hasInstance];
    // already taught, which happens when two copies of this package share one process
    if (/** @type {any} */ (klass)[kIsApplication] === true) {
        return;
    }
    Object.defineProperty(klass, Symbol.hasInstance, {
        /** @param {any} value @returns {boolean} */
        value: function (value) {
            if (previous.call(this, value)) {
                return true;
            }
            // an application is a function and a property read works on one. The guard is for the
            // primitives and nulls that reach any instanceof
            return value != null && /** @type {any} */ (value)[kIsApplication] === true;
        },
        configurable: true,
        writable: true
    });
    Object.defineProperty(klass, kIsApplication, { value: true, configurable: true });
}

acceptApplications(http.Server);
acceptApplications(net.Server);

/**
 * The net.Server members Express's API does not give, on the application prototype. Each one
 * answers for uWS, not for a node socket.
 *
 * @param {any} prototype Application.prototype
 */
function addServerMembers(prototype) {
    Object.defineProperty(prototype, kIsApplication, { value: true, configurable: true });

    /**
     * How many requests this application is serving right now. node counts sockets, there are none
     * here, and this is the number a graceful shutdown waits for. An idle keep-alive is not counted.
     *
     * @param {(err: Error|null, count: number) => void} callback
     */
    prototype.getConnections = function getConnections(callback) {
        let count = 0;
        for (let response = this._pending.head; response !== null; response = response._pendingNext) {
            count++;
        }
        // node answers this one asynchronously, and a caller written against it may rely on that
        process.nextTick(callback, null, count);
    };

    /**
     * A handle this does not own: uWS's loop keeps the process alive and a caller cannot unref it.
     * Both are no-ops returning the server, so a chain written against node's API keeps working.
     *
     * @returns {any}
     */
    prototype.ref = function ref() {
        return this;
    };

    /** @returns {any} */
    prototype.unref = function unref() {
        return this;
    };

    /**
     * Registers the callback like node's does and remembers the value, which is all a caller can
     * observe. The timeout belongs to uWS and is set through uwsOptions.idleTimeout.
     *
     * @this {any}
     * @param {number} [msecs]
     * @param {() => void} [callback]
     * @returns {any}
     */
    prototype.setTimeout = function setTimeout(msecs, callback) {
        this.timeout = msecs;
        if (callback) {
            this.on("timeout", callback);
        }
        return this;
    };

    // The numbers node's http.Server carries. Inert here, but declared rather than left undefined:
    // a library reads `server.keepAliveTimeout` to work out what it is talking to.
    for (const [name, value] of /** @type {[string, any][]} */ ([
        ["timeout", 0],
        ["keepAliveTimeout", 5000],
        ["headersTimeout", 60000],
        ["requestTimeout", 300000],
        ["maxHeadersCount", null],
        ["maxRequestsPerSocket", 0]
    ])) {
        Object.defineProperty(prototype, name, { value, writable: true, configurable: true, enumerable: false });
    }
}

module.exports = { addServerMembers, kIsApplication };
