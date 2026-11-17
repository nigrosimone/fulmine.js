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

// Express's router publishes every middleware, route handler, error handler and app.param()
// callback it runs on the express.router.request TracingChannel. The same name and the same context
// as router 2.3 here, so a tracer written for express sees fulmine too, on uWS and through node:http.

const dc = require("node:diagnostics_channel");

/** @typedef {import("./walk.js")} Walk */

/**
 * What a subscriber gets: express's own fields. `layer` stands in for express's Layer, with the
 * fields tracers read. `error` and `result` are there only once set: a tracer reads `in` on them.
 *
 * @typedef {{req: any, res: any, layer: Layer, handler: Function, route: unknown, param?: string,
 *   errorHandler?: true, incomingError?: unknown, error?: unknown, result?: unknown}} TraceContext
 * @typedef {{handle: unknown, name: string}} Layer
 */

// tracingChannel is missing on runtimes that do not have it, and then nothing is traced
const requestChannel = typeof dc.tracingChannel === "function" ? dc.tracingChannel("express.router.request") : null;

// the key express's router keeps the reported errors under, shared so that an error one of the
// two reported is not reported again by the other
const publishedErrors = Symbol.for("router.tracing.publishedErrors");

/** @type {WeakMap<object, Layer>} */
const layers = new WeakMap();

/**
 * Whether anybody listens, read once per walk. Without subscribers nothing else here runs.
 *
 * @returns {boolean}
 */
function tracing() {
    if (requestChannel === null) {
        return false;
    }
    const all = requestChannel.hasSubscribers;
    // Bun has no TracingChannel#hasSubscribers, router 2 asks each channel there
    if (all !== undefined) {
        return all;
    }
    const channel = /** @type {dc.TracingChannel<any, any>} */ (requestChannel);
    return (
        channel.start.hasSubscribers ||
        channel.end.hasSubscribers ||
        channel.asyncStart.hasSubscribers ||
        channel.asyncEnd.hasSubscribers ||
        channel.error.hasSubscribers
    );
}

/**
 * The layer of a handler, one per function as the name and the handle are all it carries.
 *
 * @param {Function} handle
 * @param {string} [name] the name express gives a mount, which is not the function's
 * @returns {Layer}
 */
function layerOf(handle, name) {
    let layer = layers.get(handle);
    if (layer === undefined) {
        layer = { handle, name: name ?? (handle.name || "<anonymous>") };
        layers.set(handle, layer);
    }
    return layer;
}

/**
 * Remembers an error on the request, and says whether it is new: not "route" or "router", which
 * are not errors, and not one seen already, upstream or by another copy of the router.
 *
 * @param {any} req
 * @param {unknown} err
 * @returns {boolean}
 */
function remember(req, err) {
    if (!err || err === "route" || err === "router") {
        return false;
    }
    /** @type {Set<unknown>|undefined} */
    let seen = req[publishedErrors];
    if (seen === undefined) {
        seen = req[publishedErrors] = new Set();
    } else if (seen.has(err)) {
        return false;
    }
    seen.add(err);
    return true;
}

/**
 * Publishes an error once, on the layer it comes from, as it is handed to next().
 *
 * @param {TraceContext} ctx
 * @param {unknown} err
 */
function report(ctx, err) {
    if (remember(ctx.req, err)) {
        ctx.error = err;
        /** @type {dc.TracingChannel<any, any>} */ (requestChannel).error.publish(ctx);
    }
}

/**
 * A throw or rejection on the context, published already or not: the terminal event carries it.
 * A thrown routing signal is not an error, it ends the call as next("route") would.
 *
 * @param {TraceContext} ctx
 * @param {unknown} err
 * @param {boolean} sync
 */
function recordThrown(ctx, err, sync) {
    if (err === "route" || err === "router") {
        if (sync) {
            ctx.result = undefined;
        }
        return;
    }
    if (!("error" in ctx)) {
        ctx.error = err;
    }
}

/**
 * The end event. `result` or `error` there means nothing follows, so an error reported before a
 * promise came back is hidden while it publishes.
 *
 * @param {TraceContext} ctx
 * @param {boolean} async
 */
function publishEnd(ctx, async) {
    const channel = /** @type {dc.TracingChannel<any, any>} */ (requestChannel);
    if (!async || !("error" in ctx)) {
        channel.end.publish(ctx);
        return;
    }
    const error = ctx.error;
    delete ctx.error;
    channel.end.publish(ctx);
    ctx.error = error;
}

/**
 * The asyncEnd of a call whose promise settled, inside the stores asyncStart binds.
 *
 * @param {TraceContext} ctx
 */
function publishAsyncEnd(ctx) {
    /** @type {dc.TracingChannel<any, any>} */ (requestChannel).asyncEnd.publish(ctx);
}

/**
 * asyncStart, then asyncEnd inside its stores.
 *
 * @param {TraceContext} ctx
 */
function settled(ctx) {
    /** @type {dc.TracingChannel<any, any>} */ (requestChannel).asyncStart.runStores(ctx, publishAsyncEnd, null, ctx);
}

/**
 * Whether a call returned a thenable, as router 2's is-promise reads it.
 *
 * @param {unknown} ret
 * @returns {ret is PromiseLike<unknown>}
 */
function isThenable(ret) {
    return (
        ret !== null &&
        (typeof ret === "object" || typeof ret === "function") &&
        typeof (/** @type {any} */ (ret).then) === "function"
    );
}

/**
 * The trace of a call that may return a promise: start and end around it, then asyncStart and
 * asyncEnd once it settles, with `result` or `error` as tracePromise sets them.
 *
 * @param {TraceContext} ctx
 * @param {() => unknown} call
 * @param {(err: unknown) => void} thrown what a throw or a rejection is handed to, as the untraced path
 * @param {boolean} thenables any thenable is a promise, as app.param() reads it; a handler's must be native
 */
function traceCall(ctx, call, thrown, thenables) {
    let done = false;
    /** @param {unknown} err */
    const rejected = (err) => {
        // routing gets every outcome, the trace only the first
        thrown(err);
        if (done) {
            return;
        }
        done = true;
        recordThrown(ctx, err, false);
        settled(ctx);
    };
    /** @param {unknown} value */
    const resolved = (value) => {
        if (done) {
            return;
        }
        done = true;
        ctx.result = value;
        settled(ctx);
    };
    /** @type {dc.TracingChannel<any, any>} */ (requestChannel).start.runStores(ctx, () => {
        let out;
        try {
            out = call();
        } catch (err) {
            // forwarded verbatim, a falsy value routes on as the untraced path does
            thrown(err);
            recordThrown(ctx, err, true);
            publishEnd(ctx, false);
            return;
        }
        const async = thenables ? isThenable(out) : out instanceof Promise;
        if (!async) {
            ctx.result = out;
        }
        publishEnd(ctx, async);
        if (async) {
            try {
                /** @type {PromiseLike<unknown>} */ (out).then(resolved, (err) =>
                    rejected(err || new Error("Rejected promise"))
                );
            } catch (err) {
                // a then that throws is a rejection, forwarded verbatim
                rejected(err);
            }
        }
    });
}

/**
 * A middleware or route handler, traced: the same call and the same error handling as Walk#step.
 *
 * @param {Walk} walk
 * @param {Function} callback
 */
function traceHandler(walk, callback) {
    const req = walk.req;
    const res = walk.res;
    const route = /** @type {NonNullable<Walk["route"]>} */ (walk.route);
    /** @type {TraceContext} */
    const ctx = { req, res, layer: layerOf(callback), handler: callback, route: route.rawPath };
    const walkNext = walk.next;
    /** @param {unknown} [err] */
    const next = (err) => {
        report(ctx, err);
        walkNext(err);
    };
    traceCall(
        ctx,
        () => callback(req, res, next),
        (err) => {
            report(ctx, err);
            walk.forward(route, err);
        },
        false
    );
}

/**
 * An error handler, traced: Router#_handleError's call and Walk#errorHop's promise handling. The
 * error it was given is `incomingError`, `error` is only what it raises itself.
 *
 * @param {Walk} walk
 * @param {Function} callback a four-argument handler
 */
function traceErrorHandler(walk, callback) {
    const req = walk.req;
    const res = walk.res;
    const route = /** @type {NonNullable<Walk["route"]>} */ (walk.route);
    const err = req._error;
    /** @type {TraceContext} */
    const ctx = {
        req,
        res,
        layer: layerOf(callback),
        handler: callback,
        route: route.rawPath,
        errorHandler: true,
        incomingError: err
    };
    // it did not come from here, even when nothing traced where it did
    remember(req, err);
    /** @param {unknown} pass */
    const passed = (pass) => {
        // recovered or replaced: the same object raised later is a new failure
        if (pass !== err) {
            /** @type {Set<unknown>|undefined} */ (/** @type {any} */ (req)[publishedErrors])?.delete(err);
        }
        report(ctx, pass);
    };
    /** @param {unknown} [pass] */
    const next = (pass) => {
        passed(pass);
        // as _handleError: cleared, not deleted
        req._error = undefined;
        req._errorKey = undefined;
        return req.next(pass);
    };
    traceCall(
        ctx,
        () => callback(err, req, res, next),
        (thrown) => {
            passed(thrown);
            walk.forward(route, thrown);
        },
        false
    );
}

/**
 * An app.param() callback, traced, with the route's layer and the parameter's name.
 *
 * @param {TraceContext} ctx
 * @param {Function} fn
 * @param {unknown} value
 * @param {string} name
 * @param {(err?: unknown) => void} next
 */
function traceParam(ctx, fn, value, name, next) {
    /** @param {unknown} [err] */
    const traced = (err) => {
        report(ctx, err);
        next(err);
    };
    traceCall(ctx, () => fn(ctx.req, ctx.res, traced, value, name), traced, true);
}

/**
 * A mounted router or app, traced as express traces the layer it mounts: start and end around
 * the synchronous part. What it hands back was reported inside, if anywhere.
 *
 * @param {Walk} walk
 * @param {any} callback the router or app
 */
function traceMount(walk, callback) {
    /** @type {TraceContext} */
    const ctx = {
        req: walk.req,
        res: walk.res,
        layer: layerOf(callback, callback._isApplication ? "mounted_app" : "router"),
        handler: callback,
        route: /** @type {NonNullable<Walk["route"]>} */ (walk.route).rawPath
    };
    /** @type {dc.TracingChannel<any, any>} */ (requestChannel).start.runStores(ctx, () => {
        walk.enterMount(callback);
        // express's router function returns nothing
        ctx.result = undefined;
        publishEnd(ctx, false);
    });
}

// node:http's own channels. Through http.createServer(app) node publishes them; on µWS fulmine does,
// at the same points, and the request goes through server.emit("request") as node sends it, where a
// tracer that wraps the server's emit (Sentry) opens its scope. The server is the app, which
// listen() returns as the server handle.
const requestStart = dc.channel("http.server.request.start");
const responseCreated = dc.channel("http.server.response.created");
const responseFinish = dc.channel("http.server.response.finish");

// OpenTelemetry's HTTP instrumentation reads no channel, it wraps http.Server.prototype.emit. On µWS
// the request goes through that wrapper too, so its span opens as on node:http
const serverProto = require("http").Server.prototype;
const EventEmitter = require("events");
const plainEmit = EventEmitter.prototype.emit;

/** @type {WeakSet<object>} the apps whose "request" event already runs the walk */
const dispatching = new WeakSet();
/** @type {WeakMap<object, EventEmitter>} per app, a node emitter that hands "request" to the app */
const relays = new WeakMap();

/**
 * Whether node:http's server channels have subscribers.
 *
 * @returns {boolean}
 */
function serverObserved() {
    return (
        requestStart.hasSubscribers ||
        responseCreated.hasSubscribers ||
        responseFinish.hasSubscribers ||
        serverProto.emit !== plainEmit
    );
}

/**
 * Whether anything listens that needs every request to run its javascript: no compiled chain, no
 * response µWS writes on its own.
 *
 * @returns {boolean}
 */
function observed() {
    return tracing() || serverObserved();
}

/**
 * Serves a µWS request as node:http does while its channels have subscribers: response.created
 * and request.start, then server.emit("request"), and response.finish when the response is out.
 *
 * @param {any} app the application, which is the server listen() returned
 * @param {any} request
 * @param {any} response
 */
function serveObserved(app, request, response) {
    const socket = request.socket;
    if (responseCreated.hasSubscribers) {
        responseCreated.publish({ request, response });
    }
    if (requestStart.hasSubscribers) {
        requestStart.publish({ request, response, socket, server: app });
    }
    if (responseFinish.hasSubscribers) {
        response.once("finish", () => responseFinish.publish({ request, response, socket, server: app }));
    }
    if (!dispatching.has(app)) {
        dispatching.add(app);
        app.on("request", (/** @type {any} */ req, /** @type {any} */ res) => app._routeRequestDirect(req, res));
    }
    if (serverProto.emit === plainEmit) {
        app.emit("request", request, response);
    } else {
        // the wrapper ends in node's own emit, which does not see the app's listeners
        let relay = relays.get(app);
        if (relay === undefined) {
            relay = new EventEmitter();
            relay.on("request", (/** @type {any} */ req, /** @type {any} */ res) => app.emit("request", req, res));
            relays.set(app, relay);
        }
        serverProto.emit.call(relay, "request", request, response);
    }
}

module.exports = {
    tracing,
    observed,
    serverObserved,
    serveObserved,
    traceHandler,
    traceErrorHandler,
    traceParam,
    traceMount
};
