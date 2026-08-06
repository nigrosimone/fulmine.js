declare module "fulmine.js" {
    import e from "express";
    import uWS from "uWebSockets.js";

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
        readonly uwsApp: uWS.TemplatedApp;
        listen(port: number, callback?: (token: any) => void): FulmineServer;
        listen(port: number, host: string, callback?: (token: any) => void): FulmineServer;
        listen(callback: (token: any) => void): FulmineServer;
        ws(path: string, behavior: WebSocketBehavior): this;
        publish(topic: string, message: string | ArrayBuffer | Buffer, isBinary?: boolean, compress?: boolean): boolean;
        numSubscribers(topic: string): number;
    }

    function express(settings?: Settings): Fulmine;

    export = express;
}
