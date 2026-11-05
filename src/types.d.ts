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
    import serveStatic = require("serve-static");

    // µWS's DeclarativeResponse, which its .d.ts does not declare: a response written once,
    // which µWS answers with by itself. end() hands back what app.uws() takes as a route
    interface DeclarativeResponse {
        writeStatus(status: string): this;
        writeHeader(key: string, value: string): this;
        // the value of a request header, a query key or a route parameter, copied in per request
        writeHeaderValue(key: string): this;
        writeQueryValue(key: string): this;
        writeParameterValue(key: string): this;
        // the request body, copied back
        writeBody(): this;
        write(value: string): this;
        end(value?: string): ArrayBuffer;
    }

    type UwsReadOptions = { limit?: number | string };

    type UwsCompressor = {
        /** The encoding to answer with, "" for none. Reads req, so before the handler returns. */
        negotiate(req: uWS.HttpRequest): string;
        send(
            res: uWS.HttpResponse,
            status: number,
            headers: Record<string, string> | null | undefined,
            body: unknown,
            encoding: string
        ): void;
    };

    // the module itself, named outside the namespace, where express.uWS would shadow it
    type UwsModule = typeof uWS & { DeclarativeResponse: new () => DeclarativeResponse };

    type Settings = {
        uwsOptions?: uWS.AppOptions;
        threads?: number;
        cluster?: boolean | number | "auto";
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

        /** serve-static's options plus preCompressed, which is this project's. */
        interface StaticOptions extends serveStatic.ServeStaticOptions<e.Response> {
            /**
             * Serve `file.br` or `file.gz` in place of `file` when one is on disk and the client
             * takes it. Off by default. Which twins a path has is remembered for a second;
             * `{ cache: false }` asks the disk every time, a duration sets how long.
             */
            preCompressed?: boolean | { cache?: number | string | false };
        }
        function static(root: string, options?: StaticOptions): e.RequestHandler;
        // export import query = e.query;

        // express has no compression middleware, so there is nothing to re-export: these are the
        // compression module's options, which this one takes as they are
        /**
         * What zlib takes for zstd, written out here rather than imported from "zlib": the type
         * arrived in @types/node only when node grew zstd, and the version of that is the
         * consumer's, so importing it would stop an older one from compiling at all.
         */
        interface ZstdCompressOptions {
            chunkSize?: number;
            maxOutputLength?: number;
            /** zlib.constants.ZSTD_c_* to their values, ZSTD_c_compressionLevel included. */
            params?: Record<number, number>;
        }
        interface CompressionOptions extends ZlibOptions {
            /** The smallest body worth compressing, in bytes or as "1kb". Default 1024. */
            threshold?: number | string;
            /** Whether this response should be compressed at all. */
            filter?: (req: e.Request, res: e.Response) => boolean;
            /** What to use when the request carries no Accept-Encoding. Default "identity". */
            enforceEncoding?: string;
            /** Brotli options. The default quality is 4. */
            brotli?: BrotliOptions;
            /** Zstd options. Node's own defaults. Offered only where zlib has zstd. */
            zstd?: ZstdCompressOptions;
            /**
             * The encodings this middleware may answer with; what is not named is never used,
             * however the client ranks it. Fulmine's own option, the compression module has no
             * equivalent. An uncompressed answer is always on offer.
             */
            encodings?: ("br" | "zstd" | "gzip" | "deflate" | "identity")[];
        }
        // what listen() decided about each route, for a test to hold on to
        interface RouteVerdict {
            /** The method as it was registered, "GET". */
            method: string;
            /** The path as it was registered, "/users/:id". */
            path: string;
            /** Whether µWS matches this route itself. */
            native: boolean;
            /** Whether it was compiled into a response written at startup. */
            declarative: boolean;
            /** Whether the chain provably reads no request header. */
            skipHeaders: boolean;
            /** Whether the chain provably reads no query. */
            skipQuery: boolean;
            /** Why it fell back to the ordinary router, when it did. */
            reason?: string;
        }
        // what one request was made to build, none of which a fast request builds
        interface WorkReport {
            /** Whether µWS matched this route itself. */
            native: boolean;
            /** Whether it was compiled into a response written at startup. */
            declarative: boolean;
            /** Whether the folded `req.headers` object was built. */
            headers: boolean;
            /** Whether the query string was parsed. */
            query: boolean;
            /** Whether a body parser put something on `req.body`. */
            body: boolean;
            /** Whether the request became a real Readable. */
            requestStream: boolean;
            /** Whether the response became a real Writable. */
            responseStream: boolean;
            /** Whether a socket stand-in was allocated. */
            socket: boolean;
        }
        type WorkField = "headers" | "query" | "body" | "requestStream" | "responseStream" | "socket";
        export namespace testing {
            /** Every route, with what compiling it decided. */
            function routeReport(app: Fulmine): RouteVerdict[];
            /** Throws unless µWS answers every route named. A trailing "*" names a prefix. */
            function expectNative(app: Fulmine, patterns: string | string[]): void;
            /** Throws unless every route named was compiled into a response. */
            function expectDeclarative(app: Fulmine, patterns: string | string[]): void;
            /** What this one request was made to build, asked from a handler or a finish listener. */
            function workReport(req: e.Request, res: e.Response): WorkReport;
            /** Throws if this request built anything `allow` does not name. */
            function expectLazy(req: e.Request, res: e.Response, options?: { allow?: WorkField[] }): void;
        }

        /** Always true here and undefined on Express: how code that may run on either tells which one it has. */
        export const isFulmine: true;

        // Server-Timing, carrying how the request was routed. Express has no such middleware, so
        // like compression() there is nothing to re-export
        interface ServerTimingOptions {
            /** Whether to report how the request was routed. Default true. */
            routing?: boolean;
            /**
             * Whether to report what the request was made to build. Default true. A request that
             * built none of it writes no such field.
             */
            work?: boolean;
            /** Whether to report the time up to the head. Default true. */
            total?: boolean;
            /** What the total is called. Default "total". */
            name?: string;
        }
        export function serverTiming(options?: ServerTimingOptions): e.RequestHandler;

        /** One uploaded file, the fields multer's memory storage gives. `buffer` is a view on the body. */
        interface MultipartFile {
            fieldname: string;
            originalname: string;
            encoding: string;
            mimetype: string;
            size: number;
            buffer: Buffer;
        }

        /**
         * What express.multipart() leaves on the request. A type of its own and not a global one:
         * multer's types declare req.files too, and two declarations of it do not merge.
         */
        interface MultipartRequest extends e.Request {
            files?: MultipartFile[];
        }

        export function multipart(options?: import("./options").BodyParserOptions): e.RequestHandler;

        export function compression(options?: CompressionOptions): e.RequestHandler;
        export namespace compression {
            /** The default filter: any compressible content type. */
            function filter(req: e.Request, res: e.Response): boolean;
        }

        export import urlencoded = e.urlencoded;

        /**
         * µWebSockets.js itself, the instance this project serves with, for what an `app.uws()`
         * route needs of it: `getParts()` to split a multipart body, `DeclarativeResponse`, the
         * compression constants. Loaded on first read, and reading it on Bun or Deno throws, since
         * µWS does not load there. Not a named ESM export: `import express from "fulmine.js"`, then
         * `express.uWS`.
         *
         * ```ts
         * const { getParts } = express.uWS;
         * ```
         */
        export const uWS: UwsModule;

        /**
         * The query, the body and the response of an `app.uws()` route, each one call away. Plain
         * functions over µWS's own `res` and `req`, so the route stays raw and pays for what it
         * calls. `query` and `compressor().negotiate` read `req`, so before the handler returns.
         *
         * ```ts
         * const { query, readText, send } = express.uwsUtils;
         * app.uws("post", "/sum", (res, req) => {
         *     const { a } = query(req);
         *     readText(res, (body) => send(res, 200, null, a + body));
         * });
         * ```
         */
        /** What app.uwsLite() takes. */
        export interface LiteOptions {
            /** The body, in req.body when the handler runs. "lent" is a Buffer good until the handler returns. */
            body?: "text" | "json" | "form" | "buffer" | "lent";
            /** Bytes or a string as "1mb", 100kb by default. */
            limit?: number | string;
            /** What express.compression() takes. */
            compress?: Record<string, unknown>;
            /** Headers req.get() reads after the handler returned or with a body. */
            headers?: string[];
            /** Whether req.url and req.path are read after the handler returned or with a body. */
            url?: boolean;
        }

        /** The req of app.uwsLite(). */
        export interface LiteRequest {
            readonly query: Record<string, any>;
            readonly params: Record<string, string>;
            readonly body: any;
            readonly method: string | undefined;
            readonly path: string;
            readonly url: string;
            get(name: string): string | undefined;
            header(name: string): string | undefined;
        }

        /** The res of app.uwsLite(). */
        export interface LiteResponse {
            readonly req: LiteRequest;
            readonly headersSent: boolean;
            statusCode: number;
            status(code: number): this;
            set(field: string, value: string | string[]): this;
            set(field: Record<string, string | string[]>): this;
            header(field: string, value: string | string[]): this;
            header(field: Record<string, string | string[]>): this;
            get(field: string): string | string[] | undefined;
            type(type: string): this;
            send(body?: unknown): this;
            json(body: unknown): this;
            end(body?: string | Uint8Array): this;
            sendStatus(code: number): this;
        }

        export type LiteHandler = (req: LiteRequest, res: LiteResponse) => unknown;

        export const uwsUtils: {
            query(req: uWS.HttpRequest): Record<string, string | string[]>;
            guard<T extends uWS.HttpResponse>(res: T): T;
            readBuffer(res: uWS.HttpResponse, callback: (body: Buffer) => void, options?: UwsReadOptions): void;
            readText(res: uWS.HttpResponse, callback: (body: string) => void, options?: UwsReadOptions): void;
            readJson(res: uWS.HttpResponse, callback: (body: any) => void, options?: UwsReadOptions): void;
            readForm(
                res: uWS.HttpResponse,
                callback: (body: Record<string, string | string[]>) => void,
                options?: UwsReadOptions
            ): void;
            send(res: uWS.HttpResponse, status: number, headers?: Record<string, string> | null, body?: unknown): void;
            compressor(options?: Omit<CompressionOptions, "filter">): UwsCompressor;
        };

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

        // The application, the socket and the behaviour, nameable from outside. `export =` leaves
        // everything declared beside it out of reach of an import, so anything wrapping ws() had
        // to write ReturnType<typeof express> and index into it to say what it takes.
        export type FulmineApplication = Fulmine;
        export type FulmineSocket = FulmineWebSocket;
        export type FulmineWebSocketBehavior = WebSocketBehavior;
        export type FulmineUwsHandler = UwsHandler;
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
        // The return types are µWS's own: it awaits nothing, but open, message and dropped are
        // declared there as returning void or a promise, and narrowing that here made an async
        // handler a type error against the library this wraps.
        // Methods rather than function-typed properties, so a handler may narrow the request or
        // the socket to one carrying what the upgrade hook hung on it, which is how this project
        // says per-connection state is kept
        // upgrade returns what an Express handler may, so `return res.sendStatus(400)` declines
        upgrade?(req: e.Request, res: e.Response): unknown;
        open?(ws: FulmineWebSocket): void | Promise<void>;
        message?(ws: FulmineWebSocket, message: ArrayBuffer, isBinary: boolean): void | Promise<void>;
        dropped?(ws: FulmineWebSocket, message: ArrayBuffer, isBinary: boolean): void | Promise<void>;
        drain?(ws: FulmineWebSocket): void;
        close?(ws: FulmineWebSocket, code: number, message: ArrayBuffer): void;
        ping?(ws: FulmineWebSocket, message: ArrayBuffer): void;
        pong?(ws: FulmineWebSocket, message: ArrayBuffer): void;
        subscription?(ws: FulmineWebSocket, topic: ArrayBuffer, newCount: number, oldCount: number): void;
    };

    // what app.uws() takes as a method, µWS's TemplatedApp names plus delete and all
    type UwsMethod =
        | "get"
        | "post"
        | "put"
        | "delete"
        | "del"
        | "patch"
        | "options"
        | "head"
        | "connect"
        | "trace"
        | "any"
        | "all"
        | Uppercase<
              "get" | "post" | "put" | "delete" | "patch" | "options" | "head" | "connect" | "trace" | "any" | "all"
          >;

    // The handler of an app.uws() route, called as µWS calls it: µWS's own HttpResponse and
    // HttpRequest, nothing of Express in front. void rather than µWS's void | Promise<void>, so
    // `(res) => res.end()` and an async handler both fit. Or, as µWS takes it, the ArrayBuffer a
    // DeclarativeResponse's end() returns, answered without entering JavaScript
    type UwsHandler = ((res: uWS.HttpResponse, req: uWS.HttpRequest) => void) | ArrayBuffer;

    // interfaces rather than aliases: `this` is how ws() answers the router or the app it was
    // called on, and an alias naming itself in an intersection is circular
    interface FulmineRouter extends e.Router {
        ws(path: string, behavior: WebSocketBehavior): this;
        /** A route µWS serves with the handler as written, see the application's uws(). */
        uws(method: UwsMethod, path: string, handler: UwsHandler): this;
        /** A route µWS serves with an (req, res) handler, see docs/uws-routes.md. */
        uwsLite(method: UwsMethod, path: string, handler: express.LiteHandler): this;
        uwsLite(method: UwsMethod, path: string, options: express.LiteOptions, handler: express.LiteHandler): this;
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
         * Where this process stands in the cluster `express({ cluster })` forked: how many workers
         * serve, this one's index, undefined in the primary, `serves`, false only in the primary,
         * which forks and serves nothing, and `share(total)`, this process's part of a budget split
         * across the workers, such as a database pool.
         *
         * ```ts
         * const app = express({ cluster: "auto" });
         * // no pool in the primary: pg reads max 0 as its default of 10
         * const pool = app.cluster.serves ? new Pool({ max: app.cluster.share(40) }) : null;
         * ```
         */
        readonly cluster: {
            readonly workers: number;
            readonly index: number | undefined;
            readonly serves: boolean;
            share(total: number): number;
        };

        /**
         * The layers the application routes through, in express's shape: one per middleware, one
         * per route with the route's own handlers under it. Express keeps this on the router it
         * builds and hands out as `app.router`, which is here too and is the application itself,
         * so `app.stack` and `app.router.stack` are the same walk. Read-only: it is rebuilt from
         * the registered routes on every read, so putting a layer into it moves nothing.
         */
        readonly stack: any[];

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
        /**
         * What listen() hands back is the app itself, and it answers as an `http.Server` so a
         * shutdown wrapper or a library testing what it was given recognises it. These are the
         * members of that surface Express's own Application does not have; the readme's
         * "Differences from Express" says which of them do something here and which are inert.
         */
        close(callback?: (error?: Error) => void): this;
        address(): { address: string; family: string; port: number } | null;
        readonly listening: boolean;
        getConnections(callback: (error: Error | null, count: number) => void): void;
        ref(): this;
        unref(): this;
        setTimeout(msecs?: number, callback?: () => void): this;
        timeout: number;
        keepAliveTimeout: number;
        headersTimeout: number;
        requestTimeout: number;
        maxHeadersCount: number | null;
        maxRequestsPerSocket: number;
        ws(path: string, behavior: WebSocketBehavior): this;
        /**
         * A route µWS serves itself, with the handler as written: called as `(res, req)` with µWS's
         * own HttpResponse and HttpRequest, exactly as a bare µWS app would call it. No Request, no
         * Response, no middleware, no error handler; reading `req` before returning,
         * `res.onAborted()` before answering late and `res.cork()` around a late write are the
         * handler's, as on µWS. It answers before the Express routes on every path its pattern
         * takes, wherever it was written. The path is µWS's pattern, matched byte for byte, with a
         * mount's path in front. Served by `app.listen()` on Node only.
         *
         * ```ts
         * app.uws("get", "/health", (res) => res.end("ok"));
         * ```
         */
        uws(method: UwsMethod, path: string, handler: UwsHandler): this;
        /** A route µWS serves with an (req, res) handler, see docs/uws-routes.md. */
        uwsLite(method: UwsMethod, path: string, handler: express.LiteHandler): this;
        uwsLite(method: UwsMethod, path: string, options: express.LiteOptions, handler: express.LiteHandler): this;
        publish(topic: string, message: string | ArrayBuffer | Buffer, isBinary?: boolean, compress?: boolean): boolean;
        numSubscribers(topic: string): number;
    }

    function express(settings?: Settings): Fulmine;

    export = express;
}

// What express.serverTiming() hangs on the response. Express's own Response extends this global
// interface, which is how a middleware adds to it. They are written per request rather than on the
// prototype, so a route only has them where that middleware ran, which the optional marks say.
declare namespace Express {
    interface Response {
        /**
         * Whether the client went away before this response was answered. µWS frees the response
         * then and writing to it does nothing, so a handler that awaited something checks this
         * first. Express has no counterpart, which is why it is optional here.
         */
        aborted?: boolean;
        /** Adds a mark of your own. A mark with only a description is a legal entry. */
        timing?(name: string, duration?: number, description?: string): this;
        /** Times a piece of work under a name. A promise is timed to where it settles. */
        time?<T>(name: string, work: () => T): T;
    }
}
