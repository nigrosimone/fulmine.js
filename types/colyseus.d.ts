// The part of Colyseus src/colyseus.js uses, for the typecheck only: the real packages are an
// optional peer, and as dev dependencies they would bring their own uWebSockets.js into the tree.

declare module "@colyseus/uwebsockets-transport" {
    export class uWebSocketsTransport {
        app: any;
        getExpressApp(): any;
        bindRouter(router: any): void;
        handleUnmatchedRequest?(res: any, req: any): boolean;
    }
}

declare module "@colyseus/core" {
    export const matchMaker: {
        controller: {
            DEFAULT_CORS_HEADERS: Record<string, string | number | boolean>;
            getCorsHeaders(headers: Headers): Record<string, string | number | boolean>;
        };
    };
}
