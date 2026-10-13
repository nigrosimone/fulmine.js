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

// require("fulmine.js/colyseus"): Colyseus's uWebSockets.js transport with Fulmine as its Express
// layer, in place of uwebsockets-express.
//
//     const { defineServer } = require("@colyseus/core");
//     const { FulmineTransport } = require("fulmine.js/colyseus");
//
//     defineServer({ transport: new FulmineTransport(), rooms, express: (app) => app.get(...) });
//
// Fulmine adopts the transport's own uWS app: the routes it can match go to uWS, and the requests
// Colyseus does not route come to Fulmine. Optional peer dependency.

"use strict";

const { uWebSocketsTransport } = require("@colyseus/uwebsockets-transport");
const { matchMaker } = require("@colyseus/core");
const fulmine = require("./index.js");

/**
 * Colyseus's uWebSocketsTransport, with Fulmine serving the express routes.
 */
class FulmineTransport extends uWebSocketsTransport {
    /** @type {any} */
    _fulmine = undefined;

    /**
     * @override
     * @returns {any} the app Colyseus hands to the `express` option
     */
    getExpressApp() {
        if (this._fulmine === undefined) {
            const app = fulmine({ uwsApp: this.app });
            // the CORS headers Colyseus puts on every express answer, as its transport does
            app.use(
                function colyseusCors(
                    /** @type {import("./request.js")} */ req,
                    /** @type {import("./response.js")} */ res,
                    /** @type {() => void} */ next
                ) {
                    const controller = matchMaker.controller;
                    const headers = Object.assign(
                        {},
                        controller.DEFAULT_CORS_HEADERS,
                        controller.getCorsHeaders(new Headers(/** @type {any} */ (req.headers)))
                    );
                    for (const name in headers) {
                        res.setHeader(name, String(headers[name]));
                    }
                    next();
                }
            );
            this._fulmine = app;
        }
        return this._fulmine;
    }

    /**
     * @override
     * @param {any} router Colyseus's own routes: matchmaking, health check
     */
    bindRouter(router) {
        // registered now, the routes uWS can match go before the catch-all Colyseus adds below
        if (this._fulmine !== undefined) {
            this._fulmine._compileOptimizedRoutes();
        }
        if (typeof super.handleUnmatchedRequest === "function") {
            return super.bindRouter(router);
        }
        // a Colyseus without handleUnmatchedRequest(): its catch-all is taken and put behind ours
        const uwsApp = this.app;
        const any = uwsApp.any;
        /** @type {any} */
        let colyseus;
        uwsApp.any = (/** @type {string} */ pattern, /** @type {any} */ handler) => {
            colyseus = handler;
            return uwsApp;
        };
        try {
            super.bindRouter(router);
        } finally {
            uwsApp.any = any;
        }
        uwsApp.any("/*", (/** @type {any} */ res, /** @type {any} */ req) => {
            // getCaseSensitiveMethod: getMethod() lowercases it inside the request Fulmine reads next
            if (router.findRoute(req.getCaseSensitiveMethod(), req.getUrl()) !== undefined) {
                return colyseus(res, req);
            }
            if (!this.handleUnmatchedRequest(res, req)) {
                colyseus(res, req);
            }
        });
    }

    /**
     * A request no Colyseus route matched, served by Fulmine.
     *
     * @override
     * @param {any} res µWS's response
     * @param {any} req µWS's request
     * @returns {boolean}
     */
    handleUnmatchedRequest(res, req) {
        if (this._fulmine === undefined) {
            return false;
        }
        this._fulmine._serveGeneric(res, req);
        return true;
    }
}

module.exports = { FulmineTransport };
