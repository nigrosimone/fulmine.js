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

"use strict";

const { canBeOptimizedWithParams, decodeParam, NullObject } = require("./utils.js");

// the parameter names in a path, in the order µWS numbers them
const PARAM = /:(\w+)/g;

// Handlers µWS calls with the socket. Everything else in a behavior object is a µWS setting
// (maxPayloadLength, idleTimeout, compression, ...) and rides through untouched.
const SOCKET_HANDLERS = ["open", "message", "dropped", "drain", "close", "ping", "pong", "subscription"];

/**
 * Joins a mount path and a route path the way the router does, without the empty-string edges
 * that would leave a double slash.
 *
 * @param {string} prefix
 * @param {string} path
 * @returns {string}
 */
function joinPaths(prefix, path) {
    if (!prefix || prefix === "/") {
        return path;
    }
    if (!path || path === "/") {
        return prefix;
    }
    return prefix + path;
}

/**
 * Every websocket route reachable from this router, with the mount paths already applied.
 *
 * Walked separately from the HTTP routes: those fall back to ordinary routing when µWS cannot
 * match them, and a websocket has no fallback to fall back to, so an unmountable one has to be
 * refused out loud instead.
 *
 * @param {any} router
 * @param {string|null} prefix the mount path accumulated so far, or null once a mount was a
 *   shape µWS cannot match, which makes everything below it unreachable
 * @param {any[]} out
 * @param {Set<any>} seen routers already walked, since a router may be mounted twice
 */
function collectRoutes(router, prefix, out, seen) {
    if (seen.has(router)) {
        return;
    }
    seen.add(router);

    for (const entry of router._wsRoutes ?? []) {
        if (prefix === null) {
            throw new Error(
                `websocket route "${entry.path}" sits under a mount µWS cannot match. ` +
                    "Mount the router on a literal path, or on one whose parameters are whole segments."
            );
        }
        const path = joinPaths(prefix, entry.path);
        if (!canBeOptimizedWithParams(path)) {
            throw new Error(
                `websocket path "${path}" is not one µWS can match. Use a literal path, or ` +
                    "parameters that are a whole segment, as in /room/:id."
            );
        }
        out.push({ path, behavior: entry.behavior, owner: entry.owner });
    }

    for (const route of router._routes) {
        if (!route.use) {
            continue;
        }
        for (const callback of route.callbacks) {
            // a mounted Router, or a callable sub-app, which is a function carrying routes
            if (callback && callback._routes) {
                const mount =
                    prefix === null || typeof route.path !== "string" || !canBeOptimizedWithParams(route.path)
                        ? null
                        : joinPaths(prefix, route.path);
                collectRoutes(callback, mount, out, seen);
            }
        }
    }
}

/**
 * The µWS upgrade handler for one route: it builds this project's request and response, offers
 * them to the application's own `upgrade` hook, and completes the handshake unless that hook
 * answered the request itself.
 *
 * @param {any} app the application whose request and response classes serve this route
 * @param {string} path the composed path, whose parameters are read back by index
 * @param {any} behavior what the caller registered
 * @param {any} rootApp the application whose uwsApp carries the socket, and so the connection set
 * @returns {(res: any, req: any, context: any) => void}
 */
function makeUpgradeHandler(app, path, behavior, rootApp) {
    const paramNames = [...path.matchAll(PARAM)].map((match) => match[1]);
    const userUpgrade = behavior.upgrade;

    return (res, req, context) => {
        // read off the µWS request before anything can await: it is neutered on return, and the
        // handshake needs these three even when the upgrade is decided asynchronously
        const key = req.getHeader("sec-websocket-key");
        const protocol = req.getHeader("sec-websocket-protocol");
        const extensions = req.getHeader("sec-websocket-extensions");

        const request = new app._request(req, res, app);
        if (paramNames.length) {
            const params = new NullObject();
            for (let i = 0; i < paramNames.length; i++) {
                params[paramNames[i]] = decodeParam(req.getParameter(i));
            }
            request.params = params;
        }

        let aborted = false;

        /** Completes the handshake, unless the hook answered or the client already left. */
        const accept = () => {
            if (aborted || request.res?.finished) {
                return;
            }
            // the socket stops being HTTP here: the connection filter never reports an upgraded
            // socket closing, and a close() reaching one through the held HTTP wrapper is a
            // native crash, so the connection set forgets it now
            rootApp._releaseConnection?.(res);
            // the socket outlives the response, so what only the response can answer is read
            // while it is still alive: reading it later would be a use after free
            request._detachFromResponse();
            res.cork(() => {
                res.upgrade({ req: request }, key, protocol, extensions, context);
            });
        };

        if (!userUpgrade) {
            accept();
            return;
        }

        const response = new app._response(res, request, app);
        request.res = response;

        let decision;
        try {
            decision = userUpgrade(request, response);
        } catch (err) {
            // an upgrade that throws refuses the socket, and says so the way an unhandled route
            // would rather than leaving the client hanging on a half-open handshake
            if (!response.finished) {
                res.cork(() => {
                    response.status(500).end();
                });
            }
            app.emit("error", err);
            return;
        }

        if (!decision || typeof decision.then !== "function") {
            accept();
            return;
        }

        // an async hook (a session lookup, a token check) outlives this callback, so µWS has to
        // be told who to call if the client leaves first. Registered now, still inside the
        // handler, which is the only place µWS accepts it
        res.onAborted(() => {
            aborted = true;
        });
        // and whatever the hook writes now lands outside the cork µWS holds for this callback,
        // so the response opens its own, exactly as a route handler answering late does
        response._corkNeeded = true;
        decision.then(accept, (err) => {
            if (!aborted && !response.finished) {
                res.cork(() => {
                    response.status(500).end();
                });
            }
            app.emit("error", err);
        });
    };
}

/**
 * Hands every websocket route this application can reach to µWS. Called from listen(), before
 * the catch-all goes on: µWS routes an upgrade to the websocket route even when a catch-all
 * covers the same path, so the two live side by side.
 *
 * @param {any} app
 */
function registerWebSocketRoutes(app) {
    const routes = [];
    collectRoutes(app, "", routes, new Set());
    for (const route of routes) {
        const uwsBehavior = { ...route.behavior };
        delete uwsBehavior.upgrade;
        // bound to the owner's classes, so a mounted sub-app's request layer is the one its own
        // handlers expect
        uwsBehavior.upgrade = makeUpgradeHandler(route.owner ?? app, route.path, route.behavior, app);
        app.uwsApp.ws(route.path, uwsBehavior);
    }
}

/**
 * Whatever a caller passed as a behavior, checked where it is written rather than where it is
 * used: a handler under a misspelled name would otherwise never run and never say why.
 *
 * @param {string} path
 * @param {any} behavior
 */
function checkBehavior(path, behavior) {
    if (typeof path !== "string") {
        throw new TypeError("app.ws() requires a path string");
    }
    if (!behavior || typeof behavior !== "object") {
        throw new TypeError("app.ws() requires a behavior object, as µWS takes");
    }
    if (!canBeOptimizedWithParams(path)) {
        throw new Error(
            `websocket path "${path}" is not one µWS can match. Use a literal path, or ` +
                "parameters that are a whole segment, as in /room/:id."
        );
    }
    for (const name of [...SOCKET_HANDLERS, "upgrade"]) {
        if (behavior[name] !== undefined && typeof behavior[name] !== "function") {
            throw new TypeError(`app.ws() behavior.${name} must be a function`);
        }
    }
}

module.exports = { registerWebSocketRoutes, checkBehavior };
