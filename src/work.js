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

// What one request made this framework build (Readable, Writable, folded headers, parsed query,
// socket stand-in), read from state already kept: one careless middleware brings it all back and
// nothing fails. Whether the headers were copied is the chain's, see routeReport().skipHeaders.
// Read by express.testing.expectLazy and express.serverTiming()

"use strict";

/** @typedef {import("./request.js")} Request */
/** @typedef {import("./response.js")} Response */

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
 * What this request did so far. The answer changes while the chain runs, so ask at the end of it.
 *
 * @param {Request} req
 * @param {Response} res the response, since half of this is about the response
 * @returns {Work}
 */
function work(req, res) {
    const native = req.route?._native;
    // cast for the three the classes do not declare: `body` is deliberately not a field of
    // Request, and the two stream states are node's own, written when a lazy stream is built
    const loose = /** @type {{body?: unknown, _readableState?: unknown}} */ (req);
    return {
        native: Boolean(native),
        declarative: Boolean(native?.declarative),
        headers: req._headersBuilt,
        query: req._queryParsed,
        body: loose.body !== undefined,
        requestStream: loose._readableState !== undefined,
        responseStream: /** @type {{_writableState?: unknown}} */ (res)._writableState !== undefined,
        socket: req._socketBuilt || res._socketBuilt
    };
}

// The order both readers list them in, cheapest first, so a header and a failure message agree.
/** @type {[keyof Work, string][]} */
const NAMES = [
    ["headers", "headers"],
    ["query", "query"],
    ["body", "body"],
    ["requestStream", "req stream"],
    ["responseStream", "res stream"],
    ["socket", "socket"]
];

/**
 * The names of everything that did happen, for a message or a header. Empty is the good case.
 *
 * @param {Work} done
 * @returns {string[]}
 */
function names(done) {
    const listed = [];
    for (const [key, name] of NAMES) {
        if (done[key]) {
            listed.push(name);
        }
    }
    return listed;
}

module.exports = { work, names };
