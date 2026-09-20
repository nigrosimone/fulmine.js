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

// require("fulmine.js/nest"): the Nest HTTP adapter, so a Nest application runs on uWS.
//
//     import { NestFactory } from "@nestjs/core";
//     import { FulmineExpressAdapter } from "fulmine.js/nest";
//
//     const app = await NestFactory.create(AppModule, new FulmineExpressAdapter());
//     await app.listen(3000);
//
// @nestjs/platform-express takes any Express instance, so only three methods are overridden:
// initHttpServer (the app is already an http.Server, no createServer and no node-shim slow path),
// registerParserMiddleware (it looks for the parsers in app.router.stack, which is not here) and
// httpsOptions (TLS is uWS's, set when the app is built, so it is refused). Optional peer dependency.

"use strict";

const { ExpressAdapter } = require("@nestjs/platform-express");
const fulmine = require("./index.js");

/**
 * Nest's Express adapter, listening on uWebSockets.js instead of node.
 *
 * Pass a configured app when you need one, `new FulmineExpressAdapter(fulmine({ uwsOptions }))`.
 * With no argument it builds a default one, like `new ExpressAdapter()`.
 */
class FulmineExpressAdapter extends ExpressAdapter {
    /**
     * Stands in for the layer array Express has. See registerParserMiddleware below.
     * @type {boolean}
     */
    _parsersRegistered = false;

    /**
     * @param {import("fulmine.js").FulmineApplication} [instance] an application from `fulmine()`; one is
     *   created when omitted
     */
    constructor(instance) {
        super(instance || fulmine());
    }

    /**
     * The app is the server. Nest calls this once, from NestApplication's constructor.
     *
     * @override
     * @param {import("@nestjs/common").NestApplicationOptions} [options] the options NestFactory.create was given
     * @returns {void}
     */
    initHttpServer(options) {
        if (options?.httpsOptions) {
            throw new Error(
                "fulmine.js: httpsOptions cannot be used here, since there is no node server to give " +
                    "them to. TLS belongs to µWS and is configured when the app is built:\n" +
                    '  new FulmineExpressAdapter(fulmine({ uwsOptions: { key_file_name: "key.pem", cert_file_name: "cert.pem" } }))'
            );
        }
        this.httpServer = this.getInstance();
        if (options?.forceCloseConnections) {
            // trackOpenConnections() listens for 'connection', which nothing emits: the sockets
            // belong to uWS. Warned through Nest's own logger, private in the typings but there
            /** @type {any} */ (this).logger.warn(
                "forceCloseConnections has no effect on fulmine.js: the sockets belong to µWS. " +
                    "app.close() stops accepting and waits for the requests in flight; an idle keep-alive " +
                    "connection is closed by µWS through uwsOptions.idleTimeout, not by node."
            );
        }
    }

    /**
     * Nest's json and urlencoded parsers, added once however often this is called. Express looks
     * for them in `app.router.stack`; there is no such array here, so a second call was putting a
     * second pair in front of every request.
     *
     * @override
     * @param {string} [prefix]
     * @param {boolean} [rawBody]
     * @returns {void}
     */
    registerParserMiddleware(prefix, rawBody) {
        if (this._parsersRegistered) return;
        this._parsersRegistered = true;
        super.registerParserMiddleware(prefix, rawBody);
    }
}

// a named export, the way @nestjs/platform-express exports ExpressAdapter
module.exports = { FulmineExpressAdapter };
