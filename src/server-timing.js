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
// A stopwatch middleware is nothing new, and there are several on npm. What none of them can add
// is how the request was routed, because in every other framework there is only one way:
//
//     Server-Timing: route;desc="native", hdr;desc="not copied", total;dur=0.42
//
// `route;desc="native"` means µWS matched the path in C++ and handed over a chain worked out at
// startup. `route;desc="router"` means this request was matched here, in javascript, layer by
// layer. That is the difference between the two halves of this project, per request, in the
// browser's network panel, for someone who would never run a CLI.
//
// What it cannot show is the route that is faster still: a handler compiled into a response never
// enters javascript, so no middleware runs on it and there is nothing to time. `npx fulmine
// profile` is where those are counted.
//
// The duration ends where the header does. Server-Timing goes out with the head, so `total` covers
// everything up to the moment the answer starts leaving, and not the body after it. Every stopwatch
// middleware has that boundary; this one says so.

"use strict";

/**
 * A duration in milliseconds, as Server-Timing writes them: two decimals, which is a hundredth of
 * a millisecond and finer than anything above it is worth.
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
 * @param {boolean} [options.total] whether to report the time up to the head. Default true.
 * @param {string} [options.name] what the total is called. Default "total".
 * @returns {(req: any, res: any, next: (err?: any) => void) => void}
 */
function serverTiming(options) {
    const opts = options || {};
    const routing = opts.routing !== false;
    const wantsTotal = opts.total !== false;
    const totalName = opts.name || "total";

    return function serverTiming(req, res, next) {
        const started = process.hrtime.bigint();
        /** @type {string[]} */
        const marks = [];

        /**
         * Adds a mark of the caller's own, which is what the rest of Server-Timing is for: the
         * query, the upstream call, the render. A duration is optional, since a mark with only a
         * description is a legal entry and is how a cache hit is usually reported.
         *
         * @param {string} name a token: letters, digits, dash and underscore
         * @param {number} [duration] milliseconds
         * @param {string} [description]
         * @returns {any} the response, so calls chain
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
         * Times a piece of work under a name, whatever it is: the value comes back, and a promise
         * is timed to where it settles.
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
                    /** @param {any} resolved */ (resolved) => {
                        done();
                        return resolved;
                    },
                    /** @param {any} err */ (err) => {
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
                // what the router decided about the route this request ran, which is the same
                // verdict npx fulmine profile prints for it
                const native = req.route?._native;
                entries.push(`route;desc=${describe(native ? "native" : "router")}`);
                if (native) {
                    entries.push(`hdr;desc=${describe(native.skipHeaders ? "not copied" : "copied")}`);
                    if (native.skipQuery) {
                        entries.push(`query;desc=${describe("not parsed")}`);
                    }
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
