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

// Express's router publishes every middleware, route handler and error handler it runs on the
// express.router.request TracingChannel (pillarjs/router#196). The same name and the same context
// here, so a tracer written for express sees fulmine too, on uWS and through node:http alike.

const dc = require("node:diagnostics_channel");

/** @typedef {import("./walk.js")} Walk */

/**
 * What a subscriber gets: express's own fields. `layer` stands in for express's Layer, with the
 * fields tracers read.
 *
 * @typedef {{req: any, res: any, layer: Layer, error?: unknown, errorHandler?: true}} TraceContext
 * @typedef {{handle: unknown, name: string, keys: string[], params: undefined, path: undefined}} Layer
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
    return requestChannel !== null && requestChannel.hasSubscribers === true;
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
        layer = { handle, name: name ?? (handle.name || "<anonymous>"), keys: [], params: undefined, path: undefined };
        layers.set(handle, layer);
    }
    return layer;
}

/**
 * Publishes an error once, on the layer it comes from: not "route" or "router", which are not
 * errors, and not again as it goes up through the outer layers.
 *
 * @param {TraceContext} ctx
 * @param {unknown} err
 */
function report(ctx, err) {
    if (!err || err === "route" || err === "router") {
        return;
    }
    const req = ctx.req;
    /** @type {Set<unknown>|undefined} */
    let seen = req[publishedErrors];
    if (seen === undefined) {
        seen = req[publishedErrors] = new Set();
    } else if (seen.has(err)) {
        return;
    }
    seen.add(err);
    ctx.error = err;
    /** @type {dc.TracingChannel<any, any>} */ (requestChannel).error.publish(ctx);
}

/**
 * The error a handler raised, recorded on the request as the untraced path does, and the walk on.
 *
 * @param {Walk} walk
 * @param {unknown} err
 */
function fail(walk, err) {
    const req = walk.req;
    const route = /** @type {NonNullable<Walk["route"]>} */ (walk.route);
    req._error = err;
    req._errorKey = route.routeKey;
    req._errorGroup = route.group;
    walk.step(undefined);
}

/**
 * The asyncStart and asyncEnd of a handler whose promise settled.
 *
 * @param {TraceContext} ctx
 */
function settled(ctx) {
    const channel = /** @type {dc.TracingChannel<any, any>} */ (requestChannel);
    channel.asyncStart.publish(ctx);
    channel.asyncEnd.publish(ctx);
}

/**
 * A middleware or route handler, traced: the same call and the same error handling as Walk#step,
 * inside start and end, with its next() reporting the error it is given.
 *
 * @param {Walk} walk
 * @param {Function} callback
 */
function traceHandler(walk, callback) {
    const channel = /** @type {dc.TracingChannel<any, any>} */ (requestChannel);
    const req = walk.req;
    const res = walk.res;
    /** @type {TraceContext} */
    const ctx = { req, res, layer: layerOf(callback) };
    const walkNext = walk.next;
    /** @param {unknown} [err] */
    const next = (err) => {
        report(ctx, err);
        walkNext(err);
    };
    channel.start.runStores(ctx, () => {
        let out;
        try {
            out = callback(req, res, next);
        } catch (err) {
            report(ctx, err);
            fail(walk, err);
            channel.end.publish(ctx);
            return;
        }
        channel.end.publish(ctx);
        if (out instanceof Promise) {
            out.then(
                () => settled(ctx),
                (err) => {
                    const error = err || new Error("Rejected promise");
                    report(ctx, error);
                    fail(walk, error);
                    settled(ctx);
                }
            );
        }
    });
}

/**
 * An error handler, traced: Router#_handleError's call and Walk#errorHop's promise handling,
 * with the error it was given in the context.
 *
 * @param {Walk} walk
 * @param {Function} callback a four-argument handler
 */
function traceErrorHandler(walk, callback) {
    const channel = /** @type {dc.TracingChannel<any, any>} */ (requestChannel);
    const req = walk.req;
    const res = walk.res;
    const err = req._error;
    /** @type {TraceContext} */
    const ctx = { req, res, error: err, layer: layerOf(callback), errorHandler: true };
    /** @param {unknown} [pass] */
    const next = (pass) => {
        report(ctx, pass);
        // as _handleError: cleared, not deleted
        req._error = undefined;
        req._errorKey = undefined;
        return req.next(pass);
    };
    channel.start.runStores(ctx, () => {
        let out;
        try {
            out = callback(err, req, res, next);
        } catch (thrown) {
            report(ctx, thrown);
            req._error = thrown;
            req.next(thrown);
            channel.end.publish(ctx);
            return;
        }
        channel.end.publish(ctx);
        if (out instanceof Promise) {
            out.then(
                () => settled(ctx),
                (rejected) => {
                    const error = rejected || new Error("Rejected promise");
                    report(ctx, error);
                    fail(walk, error);
                    settled(ctx);
                }
            );
        }
    });
}

/**
 * A mounted router or app, traced as express traces the layer it mounts: start and end around
 * the synchronous part, and the error it hands back reported if nothing inside it was.
 *
 * @param {Walk} walk
 * @param {any} callback the router or app
 */
function traceMount(walk, callback) {
    const channel = /** @type {dc.TracingChannel<any, any>} */ (requestChannel);
    /** @type {TraceContext} */
    const ctx = {
        req: walk.req,
        res: walk.res,
        layer: layerOf(callback, callback._isApplication ? "mounted_app" : "router")
    };
    channel.start.runStores(ctx, () => {
        walk.enterMount(callback, ctx);
        channel.end.publish(ctx);
    });
}

module.exports = { tracing, report, traceHandler, traceErrorHandler, traceMount };
