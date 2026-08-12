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

declare module "fulmine.js" {
    import e from "express";
    import uWS from "uWebSockets.js";
    import { ZlibOptions, BrotliOptions } from "zlib";

    type Settings = {
        uwsOptions?: uWS.AppOptions;
        threads?: number;
        http3?: boolean;
        uwsApp?: uWS.TemplatedApp;
    };

    namespace express {
        export import json = e.json;
        export import raw = e.raw;
        export import text = e.text;

        // export import application = e.application;
        export import request = e.request;
        export import response = e.response;

        export import static = e.static;
        // export import query = e.query;

        // express has no compression middleware, so there is nothing to re-export: these are the
        // compression module's options, which this one takes as they are
        interface CompressionOptions extends ZlibOptions {
            /** The smallest body worth compressing, in bytes or as "1kb". Default 1024. */
            threshold?: number | string;
            /** Whether this response should be compressed at all. */
            filter?: (req: e.Request, res: e.Response) => boolean;
            /** What to use when the request carries no Accept-Encoding. Default "identity". */
            enforceEncoding?: string;
            /** Brotli options. The default quality is 4. */
            brotli?: BrotliOptions;
        }
        export function compression(options?: CompressionOptions): e.RequestHandler;
        export namespace compression {
            /** The default filter: any compressible content type. */
            function filter(req: e.Request, res: e.Response): boolean;
        }

        export import urlencoded = e.urlencoded;

        export import RouterOptions = e.RouterOptions;
        // Router is declared rather than re-exported, because this project's routers carry ws()
        export function Router(options?: e.RouterOptions): FulmineRouter;
        export type Router = FulmineRouter;
        export import Application = e.Application;
        export import CookieOptions = e.CookieOptions;
        export import Errback = e.Errback;
        export import ErrorRequestHandler = e.ErrorRequestHandler;
        export import Express = e.Express;
        export import Handler = e.Handler;
        export import IRoute = e.IRoute;
        export import IRouter = e.IRouter;
        export import IRouterHandler = e.IRouterHandler;
        export import IRouterMatcher = e.IRouterMatcher;
        export import MediaType = e.MediaType;
        export import NextFunction = e.NextFunction;
        export import Locals = e.Locals;
        export import Request = e.Request;
        export import RequestHandler = e.RequestHandler;
        export import RequestParamHandler = e.RequestParamHandler;
        export import Response = e.Response;
        export import Send = e.Send;
    }

    type FulmineServer = ReturnType<e.Express["listen"]> & {
        uwsApp: uWS.TemplatedApp;
    };

    // what app.ws() hands the socket, and what µWS merges onto it: the request is reachable as
    // ws.req for as long as the socket is open
    type SocketData = { req: e.Request };
    type FulmineWebSocket = uWS.WebSocket<SocketData> & SocketData;

    // µWS's behavior, with its socket handlers retyped around that request and its own upgrade
    // replaced by this project's, which takes a request and a response
    type WebSocketBehavior = Omit<
        uWS.WebSocketBehavior<SocketData>,
        "upgrade" | "open" | "message" | "dropped" | "drain" | "close" | "ping" | "pong" | "subscription"
    > & {
        upgrade?: (req: e.Request, res: e.Response) => void | Promise<void>;
        open?: (ws: FulmineWebSocket) => void;
        message?: (ws: FulmineWebSocket, message: ArrayBuffer, isBinary: boolean) => void;
        dropped?: (ws: FulmineWebSocket, message: ArrayBuffer, isBinary: boolean) => void;
        drain?: (ws: FulmineWebSocket) => void;
        close?: (ws: FulmineWebSocket, code: number, message: ArrayBuffer) => void;
        ping?: (ws: FulmineWebSocket, message: ArrayBuffer) => void;
        pong?: (ws: FulmineWebSocket, message: ArrayBuffer) => void;
        subscription?: (ws: FulmineWebSocket, topic: ArrayBuffer, newCount: number, oldCount: number) => void;
    };

    // interfaces rather than aliases: `this` is how ws() answers the router or the app it was
    // called on, and an alias naming itself in an intersection is circular
    interface FulmineRouter extends e.Router {
        ws(path: string, behavior: WebSocketBehavior): this;
    }

    interface Fulmine extends Omit<e.Express, "listen"> {
        /**
         * The app is a node request handler, so it can be handed to anything that takes one. That
         * is what `http.createServer(app)` does, what supertest does, and what `@angular/ssr`'s
         * createNodeRequestHandler(app) does in the server.ts Angular generates.
         *
         * Express declares this through its own RequestHandler on the Express interface; here it
         * has to be written out, because the request and response an application sees are this
         * project's own and node's shapes only arrive through the shim. It has always worked at
         * runtime and the type did not say so, which compiled fine in JavaScript and stopped a
         * TypeScript consumer at the first line that passed the app anywhere.
         */
        (
            req: import("http").IncomingMessage,
            res: import("http").ServerResponse,
            next?: (err?: unknown) => void
        ): void | Promise<void>;

        readonly uwsApp: uWS.TemplatedApp;

        /**
         * Binds, and calls back the way Express 5 does: with nothing when the socket is listening,
         * and with the error when the bind failed, since Express registers the listen callback on
         * 'error' as well as on 'listening'. `this` inside it is the app, which is what listen
         * returns here and what Express's http.Server is there.
         *
         * A string port is accepted and is what `process.env.PORT` gives you: numeric strings are
         * bound as ports, anything else is taken as a unix socket path and bound through µWS's
         * listen_unix. The four shapes below are node's own.
         */
        listen(callback?: (error?: Error) => void): FulmineServer;
        listen(port: number | string, callback?: (error?: Error) => void): FulmineServer;
        listen(port: number | string, host: string, callback?: (error?: Error) => void): FulmineServer;
        listen(port: number | string, host: string, backlog: number, callback?: (error?: Error) => void): FulmineServer;
        ws(path: string, behavior: WebSocketBehavior): this;
        publish(topic: string, message: string | ArrayBuffer | Buffer, isBinary?: boolean, compress?: boolean): boolean;
        numSubscribers(topic: string): number;
    }

    function express(settings?: Settings): Fulmine;

    export = express;
}
