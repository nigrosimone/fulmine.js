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

// express.serverTiming(): Server-Timing, with the two things only this framework can put in it.
//
// What no other stopwatch middleware can add is how the request was routed:
//
//     Server-Timing: route;desc="native", hdr;desc="not copied", total;dur=0.42
//
// `route;desc="native"` means uWS matched the path in C++ and handed over a chain worked out at
// startup. `route;desc="router"` means this request was matched here, in javascript, layer by
// layer. A handler compiled into a response never enters javascript, so there is nothing to time
// on it: `npx fulmine profile` counts those.
//
// `work` names what the request was made to build: folded headers, parsed query, body, Readable,
// Writable, socket stand-in. A fast request builds none and the field is absent. See src/work.js.
//
// The duration ends where the header does. Server-Timing goes out with the head, so `total` covers
// everything up to the moment the answer starts leaving, and `work` has the same boundary.

"use strict";

const { work, names } = require("./work.js");

/** @typedef {import("./response.js")} Response */

/**
 * A duration in milliseconds, as Server-Timing writes them: two decimals.
 *
 * @param {bigint} nanoseconds
 * @returns {string}
 */
function millis(nanoseconds) {
    return (Number(nanoseconds) / 1e6).toFixed(2);
}

/**
 * Escapes a description for the quoted-string it goes in.
 * @param {string} text
 * @returns {string}
 */
function describe(text) {
    return `"${String(text).replace(/["\\]/g, "")}"`;
}

/**
 * Measures the request and answers with Server-Timing.
 *
 * @param {object} [options]
 * @param {boolean} [options.routing] whether to report how the request was routed. Default true.
 * @param {boolean} [options.work] whether to report what the request was made to build. Default
 *   true. Nothing is written for a request that built none of it, which is the usual one.
 * @param {boolean} [options.total] whether to report the time up to the head. Default true.
 * @param {string} [options.name] what the total is called. Default "total".
 * @returns {(req: any, res: any, next: (err?: unknown) => void) => void} the middleware. The pair is
 *   loose because the two methods below are added to the response here
 */
function serverTiming(options) {
    const opts = options || {};
    const routing = opts.routing !== false;
    const wantsWork = opts.work !== false;
    const wantsTotal = opts.total !== false;
    const totalName = opts.name || "total";

    return function serverTiming(req, res, next) {
        const started = process.hrtime.bigint();
        /** @type {string[]} */
        const marks = [];

        /**
         * Adds a mark of the caller's own: the query, the upstream call, the render. The duration
         * is optional, a mark with only a description is a legal entry.
         *
         * @param {string} name a token: letters, digits, dash and underscore
         * @param {number} [duration] milliseconds
         * @param {string} [description]
         * @returns {Response} the response, so calls chain
         */
        res.timing = function timing(name, duration, description) {
            let mark = String(name).replace(/[^\w-]/g, "");
            if (typeof duration === "number") {
                mark += `;dur=${duration.toFixed(2)}`;
            }
            if (description) {
                mark += `;desc=${describe(description)}`;
            }
            marks.push(mark);
            return this;
        };

        /**
         * Times a piece of work under a name. The value comes back, and a promise is timed to
         * where it settles.
         *
         * @param {string} name
         * @param {() => any} work
         * @returns {any} whatever the work returned
         */
        res.time = function time(name, work) {
            const from = process.hrtime.bigint();
            const done = () => res.timing(name, Number(process.hrtime.bigint() - from) / 1e6);
            let value;
            try {
                value = work();
            } catch (err) {
                done();
                throw err;
            }
            if (value && typeof value.then === "function") {
                return value.then(
                    /** @param {unknown} resolved */ (resolved) => {
                        done();
                        return resolved;
                    },
                    /** @param {unknown} err */ (err) => {
                        done();
                        throw err;
                    }
                );
            }
            done();
            return value;
        };

        const _write = res.write;
        const _end = res.end;
        let written = false;

        /** Writes the header, once, just before the head goes out with the first byte of body. */
        const stamp = () => {
            if (written || res.headersSent) {
                return;
            }
            written = true;
            const entries = [];
            if (routing) {
                // the same verdict npx fulmine profile prints for this route
                const native = req.route?._native;
                entries.push(`route;desc=${describe(native ? "native" : "router")}`);
                if (native) {
                    entries.push(`hdr;desc=${describe(native.skipHeaders ? "not copied" : "copied")}`);
                    if (native.skipQuery) {
                        entries.push(`query;desc=${describe("not parsed")}`);
                    }
                }
            }
            if (wantsWork) {
                // what this request made the framework build, which the route verdict cannot say:
                // a native route still folds the headers if a middleware reads them. Read at the
                // head, so it covers the chain and not the body, the same boundary as the total.
                const listed = names(work(req, res));
                if (listed.length !== 0) {
                    entries.push(`work;desc=${describe(listed.join(", "))}`);
                }
            }
            entries.push(...marks);
            if (wantsTotal) {
                entries.push(`${totalName};dur=${millis(process.hrtime.bigint() - started)}`);
            }
            if (entries.length !== 0) {
                res.append("Server-Timing", entries.join(", "));
            }
        };

        res.write = function write(chunk, encoding, callback) {
            stamp();
            return _write.call(this, chunk, encoding, callback);
        };
        res.end = function end(chunk, encoding, callback) {
            stamp();
            return _end.call(this, chunk, encoding, callback);
        };

        next();
    };
}

module.exports = serverTiming;
