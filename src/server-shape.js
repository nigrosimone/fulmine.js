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
// `app.listen()` returns the app, and there is no node server under it: the socket belongs to µWS.
// That is the one place where a drop-in stops being a drop-in, because the graceful shutdown
// libraries, the connection trackers and the health check wrappers do not use a server, they
// *recognise* one: `server instanceof http.Server`, then close(), address(), getConnections() and
// the events around them. Everything they need can be answered honestly here.
//
// Two halves, and the second is the delicate one:
//
//   - the members. close(), address(), listening and the events already exist on the application,
//     because Express hands back an http.Server and code written for Express uses them. What was
//     missing is the rest of the net.Server surface, added below.
//   - the recognition. An application cannot inherit from http.Server: its prototype chain already
//     runs through Router and this project's own EventEmitter, and http.Server.prototype has a
//     chain of its own that cannot be spliced into it without re-parenting node's classes for the
//     whole process. So instanceof is taught about applications instead, through the hook the
//     language provides for exactly this: Symbol.hasInstance. The patch is additive. Everything
//     that was an http.Server before still is, and the only new answer is for an application.
//
// What this deliberately does not do is pretend the plumbing is there. Nothing emits 'request',
// 'connection' or 'upgrade', because those carry node sockets and there are none: a library that
// counts connections through them counts zero, and socket.io still wants app.uwsApp. The shape is
// honest about what is behind it, which is why getConnections answers with the requests in flight
// rather than with a number nobody could stand behind.

const http = require("http");
const net = require("net");

// what marks an application, read by the instanceof hook below. A symbol rather than a property
// name, so nothing can be mistaken for an application by carrying the wrong field
const kIsApplication = Symbol.for("fulmine.application");

/**
 * Teaches `instanceof` that an application is a server, once per class. The original answer is
 * asked first and is never overruled: this only adds an answer for objects carrying the mark.
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
            // an application is a function, and a property read works on one; the guard is for the
            // primitives and the nulls that reach any instanceof
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
 * The net.Server members an application does not get from Express's side of the API, defined on
 * the application prototype. Each one answers for µWS rather than for a socket node does not have.
 *
 * @param {any} prototype Application.prototype
 */
function addServerMembers(prototype) {
    Object.defineProperty(prototype, kIsApplication, { value: true, configurable: true });

    /**
     * How many requests this application is serving right now.
     *
     * node counts sockets; there are none to count here, and the number a graceful shutdown is
     * waiting for is this one anyway: it reaches zero when the last answer has gone out. An idle
     * keep-alive connection is not counted, and closing does not wait for one either.
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
     * node's, for a handle this does not own: µWS's loop is what keeps the process alive, and it
     * is not something a caller may unref. Both are no-ops that hand the server back, so a chain
     * written against node's API keeps working.
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
     * Registers the callback the way node's does and remembers the value, which is all a caller
     * can observe. The timeout itself belongs to µWS and is set through uwsOptions.idleTimeout.
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

    // The numbers node's http.Server carries and a caller may read or write. They are inert here,
    // and they are declared rather than left undefined because reading one is how a library works
    // out what it is talking to: `server.keepAliveTimeout` undefined has been read as "not a
    // server" before now.
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
