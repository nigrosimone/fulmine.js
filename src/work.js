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

// What one request actually made this framework do, read from state it already keeps.
//
// Most of what makes this faster than Express is work that does not happen: the Readable and the
// Writable are not built, the headers are not folded into an object, the query is not parsed, the
// socket stand-in is not allocated. None of that is visible from the outside, and all of it is one
// careless middleware away from coming back: a `req.headers.host` where `req.get("host")` would do
// puts the folded object back on every request, and the answer stays correct, so nothing fails.
//
// Every field below is a property this framework already had to keep for its own reasons, so
// asking costs a load and nothing is counted, stamped or wrapped for the sake of being asked. That
// is the whole design rule here: a probe that charges the requests nobody is probing would be
// paid for by everyone, forever, to be read once.
//
// What is deliberately not here is whether the constructor copied the headers out of µWS. That is
// a decision about the chain rather than about the request, `routeReport().skipHeaders` reports it
// already, and the one case where the two differ, a granted route whose request declares a body,
// would cost a flag written on every request to be read on almost none.
//
// The two readers are `express.testing.expectLazy`, which fails a build that lost one of these,
// and `express.serverTiming()`, which writes them into the header for a browser to show.

"use strict";

/**
 * @typedef {object} Work
 * @property {boolean} native whether µWS matched this route itself
 * @property {boolean} declarative whether the route was compiled into a response at startup
 * @property {boolean} headers whether the folded `req.headers` object was built
 * @property {boolean} query whether the query string was parsed
 * @property {boolean} body whether a body parser put something on `req.body`
 * @property {boolean} requestStream whether the request became a real Readable
 * @property {boolean} responseStream whether the response became a real Writable
 * @property {boolean} socket whether a socket stand-in was allocated
 */

/**
 * What this request did, as it stands right now: the answer changes while the chain runs, so a
 * reader that wants the whole picture asks at the end of it.
 *
 * @param {any} req
 * @param {any} res the response, since half of this is about the response
 * @returns {Work}
 */
function work(req, res) {
    const native = req.route?._native;
    return {
        native: Boolean(native),
        declarative: Boolean(native?.declarative),
        headers: req._headersBuilt,
        query: req._queryParsed,
        body: req.body !== undefined,
        requestStream: req._readableState !== undefined,
        responseStream: res._writableState !== undefined,
        socket: req._socketBuilt || res._socketBuilt
    };
}

// The order the two readers list them in: what the request was made to do, cheapest first, so a
// header and a failure message read the same way.
const NAMES = [
    ["headers", "headers"],
    ["query", "query"],
    ["body", "body"],
    ["requestStream", "req stream"],
    ["responseStream", "res stream"],
    ["socket", "socket"]
];

/**
 * The names of everything that did happen, for a message or a header. Empty for the request that
 * did none of it, which is the one this framework is built to serve.
 *
 * @param {Work} done
 * @returns {string[]}
 */
function names(done) {
    const listed = [];
    for (const [key, name] of NAMES) {
        if (/** @type {any} */ (done)[key]) {
            listed.push(name);
        }
    }
    return listed;
}

module.exports = { work, names };
