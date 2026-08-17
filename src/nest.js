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

// require("fulmine.js/nest"): the Nest HTTP adapter, so a Nest application runs on µWS without
// anyone having to write this file themselves.
//
//     import { NestFactory } from "@nestjs/core";
//     import { FulmineExpressAdapter } from "fulmine.js/nest";
//
//     const app = await NestFactory.create(AppModule, new FulmineExpressAdapter());
//     await app.listen(3000);
//
// @nestjs/platform-express takes any Express instance, and this is one, so everything above the
// adapter - controllers, pipes, guards, interceptors - is untouched. Three things below it are not,
// and they are the whole reason this file exists:
//
//   - initHttpServer wraps the instance in http.createServer() and listens on that. Every request
//     would then arrive through node's parser and be replayed into µWS's shapes by node-shim.js,
//     which is the slow path that exists for supertest. The app already answers as an http.Server,
//     so it is the server instead of being put inside one.
//   - registerParserMiddleware decides whether Nest's body parsers are already in the chain by
//     scanning app.router.stack for them. There is no layer array here to scan, routes are compiled
//     rather than kept as layers, so the answer was always "no" and a second call added a second
//     pair. It is remembered here instead, which is the same answer by a different route.
//   - httpsOptions asks node to make a TLS server out of the instance. TLS here belongs to µWS and
//     is configured when the app is built, so that combination is refused with the line to write
//     rather than silently starting a plaintext server.
//
// @nestjs/platform-express is an optional peer dependency: this file is the only one that requires
// it, and nothing loads this file unless you ask for it by name.

"use strict";

const { ExpressAdapter } = require("@nestjs/platform-express");
const fulmine = require("./index.js");

/**
 * Nest's Express adapter, listening on µWebSockets.js instead of on node.
 *
 * Pass a configured app when you need one, `new FulmineExpressAdapter(fulmine({ uwsOptions }))`;
 * with no argument it builds a default one, the same as `new ExpressAdapter()` does.
 */
class FulmineExpressAdapter extends ExpressAdapter {
    /**
     * @param {any} [instance] an application from `fulmine()`; one is created when omitted
     */
    constructor(instance) {
        super(instance || fulmine());
        /**
         * Whether Nest's body parsers are in the chain, standing in for the layer array Express
         * has and this does not. See registerParserMiddleware below.
         * @type {boolean}
         */
        this._parsersRegistered = false;
    }

    /**
     * The app is the server. Nest calls this once, from NestApplication's constructor.
     *
     * @param {any} [options] the options NestFactory.create was given
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
            // belong to µWS and never become node ones. Said out loud, because a shutdown that
            // quietly waits forever for what it thinks it can destroy is worse than one that does
            // not offer to. Through Nest's own logger, so the line arrives where every other line
            // from the framework does; it is private in the typings and inherited all the same
            /** @type {any} */ (this).logger.warn(
                "forceCloseConnections has no effect on fulmine.js: the sockets belong to µWS. " +
                    "app.close() stops accepting and waits for the requests in flight; an idle keep-alive " +
                    "connection is closed by µWS through uwsOptions.idleTimeout, not by node."
            );
        }
    }

    /**
     * Nest's json and urlencoded parsers, added once however often this is called.
     *
     * Express answers "are they there already" by scanning `app.router.stack` for a layer whose
     * handler is named `jsonParser` or `urlencodedParser`. There is no such array here, so the scan
     * answered no every time and a second call put a second pair in front of every request.
     *
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

// a named export and nothing else: `import { FulmineExpressAdapter } from "fulmine.js/nest"`, which
// is how @nestjs/platform-express exports ExpressAdapter too
module.exports = { FulmineExpressAdapter };
