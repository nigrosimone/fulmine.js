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

const { METHODS } = require("http");
const { NullObject } = require("./utils.js");

// how many handlers may run one after another before the stack is let go of. Express uses the
// same number for the same reason: a route with thousands of synchronous handlers would otherwise
// grow the call stack until it blows
const SYNC_LIMIT = 100;

/**
 * The handlers registered for one path, and the walk over them.
 *
 * Express exports this, and code that builds a route by hand rather than through a router uses it:
 * `new Route(path)`, a handler per verb, then `dispatch(req, res, done)`. It does no matching, the
 * caller having decided the route is the right one; all it knows is which verb a handler answers.
 */
class Route {
    /**
     * @param {string} path what this route was registered for. Kept for whoever reads it, since
     *   matching happens before dispatch
     */
    constructor(path) {
        this.path = path;
        /** @type {{method: string|undefined, handle: Function}[]} */
        this.stack = [];
        // which verbs have a handler, which is what an OPTIONS reply is built from
        this.methods = new NullObject();
    }

    /**
     * Whether this route answers the verb, HEAD falling back to GET as it does over the wire.
     *
     * @param {string} method
     * @returns {boolean}
     */
    handlesMethod(method) {
        const lowered = method.toLowerCase();
        return Boolean(this.methods[lowered] || (lowered === "head" && this.methods.get));
    }

    /**
     * The verbs this route answers, in upper case, HEAD included when GET is there.
     *
     * @returns {string[]}
     */
    _methods() {
        const methods = Object.keys(this.methods);
        if (this.methods.get && !this.methods.head) {
            methods.push("head");
        }
        return methods.map((method) => method.toUpperCase());
    }

    /**
     * Runs the handlers this request's verb reaches, one after another through next().
     *
     * @param {any} req
     * @param {any} res
     * @param {(err?: any) => void} done called when the route is finished with the request, with
     *   whatever error it ended on
     */
    dispatch(req, res, done) {
        let index = 0;
        let sync = 0;
        const stack = this.stack;
        if (stack.length === 0) {
            return done();
        }

        let method = String(req.method ?? "").toLowerCase();
        if (method === "head" && !this.methods.head) {
            method = "get";
        }
        req.route = this;

        const next = (err) => {
            // next("route") leaves this route, and next("router") leaves whoever is running it
            if (err === "route") {
                return done();
            }
            if (err === "router") {
                return done(err);
            }
            if (index >= stack.length) {
                return done(err);
            }
            if (++sync > SYNC_LIMIT) {
                sync = 0;
                return setImmediate(next, err);
            }

            let layer;
            let matched = false;
            while (!matched && index < stack.length) {
                layer = stack[index++];
                matched = !layer.method || layer.method === method;
            }
            if (!matched) {
                return done(err);
            }

            const handle = /** @type {any} */ (layer).handle;
            // an error only reaches the four-argument handlers, and everything else only runs
            // while there is no error, which is the same rule ordinary dispatch follows
            if (err) {
                if (handle.length !== 4) {
                    return next(err);
                }
                try {
                    handle(err, req, res, next);
                } catch (thrown) {
                    next(thrown);
                }
            } else {
                if (handle.length === 4) {
                    return next();
                }
                try {
                    handle(req, res, next);
                } catch (thrown) {
                    next(thrown);
                }
            }
            sync = 0;
        };

        next();
    }
}

/**
 * Refuses a handler that could never be called, worded as express words it.
 *
 * @param {string} method the verb this was registered for, for the message
 * @param {any[]} handlers
 */
function checkRouteHandlers(method, handlers) {
    for (const handle of handlers) {
        if (typeof handle !== "function") {
            const type = Object.prototype.toString.call(handle);
            throw new TypeError(`Route.${method}() requires a callback function but got a ${type}`);
        }
    }
}

// every verb, plus all(), registered the same way: flattened, checked, then pushed with the verb
// they answer. all() pushes handlers with no verb at all, which matches every request
for (const method of ["all", ...METHODS.map((verb) => verb.toLowerCase())]) {
    if (method !== "all" && typeof Route.prototype[method] === "function") {
        continue;
    }
    Route.prototype[method] = function (...handlers) {
        const flattened = handlers.flat(Infinity);
        checkRouteHandlers(method, flattened);
        for (const handle of flattened) {
            this.stack.push({ method: method === "all" ? undefined : method, handle });
            if (method !== "all") {
                this.methods[method] = true;
            }
        }
        return this;
    };
}

module.exports = Route;
