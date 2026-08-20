import { expectType, expectAssignable, expectError } from "tsd";
import express from "fulmine.js";
import type { Request, Response, NextFunction, IRouter, RequestHandler, ErrorRequestHandler } from "express";
import type { Server } from "http";
import type uWS from "uWebSockets.js";

const app = express();

// Common properties
expectAssignable<string | string[]>(app.mountpath);
expectAssignable<Record<string, any>>(app.locals);

// HTTP methods
app.get("/test", (_req, res) => res.send("GET"));
app.post("/test", (_req, res) => res.send("POST"));
app.put("/test", (_req, res) => res.send("PUT"));
app.delete("/test", (_req, res) => res.send("DELETE"));
app.patch("/test", (_req, res) => res.send("PATCH"));
app.all("/all", (_req, res) => res.send("ALL"));

// Settings
app.set("view engine", "pug");
expectType<any>(app.get("view engine"));
expectType<boolean>(app.enabled("trust proxy"));

// Middleware
app.use((_req, _res, next) => next());
app.use("/api", (_req, _res, next) => next());

// Request
app.get("/request", (req: Request, res: Response) => {
    expectType<string>(req.method);
    expectType<string>(req.url);
    expectType<string>(req.path);
    expectType<any>(req.body);
    expectAssignable<Record<string, any>>(req.query);
    // a named wildcard such as /*splat arrives as the array of segments it matched,
    // so a parameter is a string or an array of them
    expectAssignable<Record<string, string | string[]>>(req.params);
    expectType<any>(req.cookies);

    expectType<string | undefined>(req.get("Content-Type"));
    expectAssignable<string | false | string[]>(req.accepts("json"));
    expectAssignable<string | false | null>(req.is("json"));

    res.send("OK");
});

// Request with generics
app.get<{ id: string }>("/users/:id", (req, res) => {
    expectType<string>(req.params.id);
    res.send("OK");
});

// Response
app.get("/response", (_req: Request, res: Response) => {
    res.send("text");
    res.json({ ok: true });
    res.status(200).send("OK");
    res.redirect("/home");

    res.set("X-Custom", "value");
    expectType<string | undefined>(res.get("Content-Type"));

    res.cookie("name", "value", { httpOnly: true });
    res.clearCookie("name");

    expectType<boolean>(res.headersSent);
    expectAssignable<Record<string, any>>(res.locals);
});

// Router
const router = express.Router();
expectAssignable<IRouter>(router);

router.get("/test", (_req, res) => res.send("OK"));
router.use((_req, _res, next) => next());
router.param("id", (_req, _res, next, id) => {
    console.log(id);
    next();
});

app.use("/api", router);

// Router with options
const strictRouter = express.Router({ strict: true, mergeParams: true });
expectAssignable<IRouter>(strictRouter);

// Middleware types
const handler: RequestHandler = (_req, res) => res.send("OK");
expectAssignable<RequestHandler>(handler);

const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
};
expectAssignable<ErrorRequestHandler>(errorHandler);

app.use(handler);
app.use(errorHandler);

// Built-in middleware
expectAssignable<RequestHandler>(express.json());
expectAssignable<RequestHandler>(express.json({ limit: "10mb" }));

expectAssignable<RequestHandler>(express.urlencoded({ extended: true }));

expectAssignable<RequestHandler>(express.static("public"));
expectAssignable<RequestHandler>(express.static("public", { maxAge: "1d" }));

expectAssignable<RequestHandler>(express.raw());
expectAssignable<RequestHandler>(express.text());

// Middleware chain
app.post(
    "/users",
    express.json(),
    (req, res, next) => {
        if (!req.body.name) return res.status(400).send("Name required");
        next();
    },
    (_req, res) => res.status(201).json({ created: true })
);

// Sub-router pattern
const apiRouter = express.Router();
apiRouter.get("/users", (_req, res) => res.json([]));
apiRouter.post("/users", express.json(), (_req, res) => res.status(201).json({}));
app.use("/api/v1", apiRouter);

// Error handling
app.use((_req, res) => res.status(404).json({ error: "Not Found" }));
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
});

const server = app.listen(3000);
expectAssignable<Server>(server);
server.close();

// The surface that is Fulmine's own rather than re-exported from Express: the constructor
// settings, the uWS app hanging off both the application and the server, and the listen
// overloads.
const configured = express({
    threads: 2,
    http3: false,
    uwsOptions: { key_file_name: "key.pem", cert_file_name: "cert.pem" }
});
expectType<uWS.TemplatedApp>(configured.uwsApp);

// The callback is Express 5's, not µWS's: nothing on success, the error when the bind failed. This
// used to be typed as a µWS listen token, which never arrives, and the type test asserted the same
// wrong thing. Verified against the runtime: zero arguments on success, one EADDRINUSE error when
// the port is taken.
const bound = configured.listen(3000, (error) => {
    expectType<Error | undefined>(error);
});
expectType<uWS.TemplatedApp>(bound.uwsApp);
bound.close();

expectAssignable<Server>(configured.listen(3000, "127.0.0.1"));
expectAssignable<Server>(configured.listen((_error) => {}));
// what process.env.PORT gives you, which is what every generated server.ts passes
expectAssignable<Server>(configured.listen(process.env.PORT || 4000, (_error) => {}));
// and node's fourth shape, which the runtime has always accepted
expectAssignable<Server>(configured.listen(3000, "127.0.0.1", 511, () => {}));

// an existing uWS app can be handed in instead of letting Fulmine create one
express({ uwsApp: configured.uwsApp }).listen(3001).close();

// The named exports, which are a separate question from the default one: Node decides which of
// them an ESM importer can have by reading src/index.js with cjs-module-lexer, and TypeScript
// decides by reading src/types.d.ts. Both have to agree, and the runtime half is pinned by
// tests/tests/app/app-esm-named-exports.js.
import {
    Router as NamedRouter,
    json as namedJson,
    urlencoded as namedUrlencoded,
    text as namedText,
    raw as namedRaw,
    static as namedStatic
} from "fulmine.js";
import type { Request as FulmineRequest, Response as FulmineResponse } from "fulmine.js";

// assignable rather than exact: this project's router is an Express one plus ws()
expectAssignable<IRouter>(NamedRouter());
expectAssignable<RequestHandler>(namedJson());
expectAssignable<RequestHandler>(namedUrlencoded());
expectAssignable<RequestHandler>(namedText());
expectAssignable<RequestHandler>(namedRaw());
expectAssignable<RequestHandler>(namedStatic("public"));

// the type names come through as well, which is what the README example uses
const typedHandler = (req: FulmineRequest, res: FulmineResponse) => {
    // a wildcard parameter is captured as an array, so a value is not always a string
    expectAssignable<Record<string, string | string[]>>(req.params);
    res.json({ ok: true });
};
expectAssignable<RequestHandler>(typedHandler);

// WebSockets: the behavior is µWS's, the upgrade hook and ws.req are this project's
app.ws("/room/:id", {
    maxPayloadLength: 1024,
    idleTimeout: 60,
    upgrade(req, res) {
        // a parameter is a string or, for a wildcard, the segments it matched
        expectAssignable<string | string[]>(req.params.id);
        if (!req.query.token) res.sendStatus(401);
    },
    open(ws) {
        expectAssignable<FulmineRequest>(ws.req);
        ws.subscribe("room");
    },
    message(ws, message, isBinary) {
        expectType<ArrayBuffer>(message);
        expectType<boolean>(isBinary);
        ws.send(message, isBinary);
    },
    close(ws, code) {
        expectType<number>(code);
    }
});
expectType<boolean>(app.publish("room", "hello"));
expectType<number>(app.numSubscribers("room"));
NamedRouter().ws("/lobby", {
    open(ws) {
        ws.send(ws.req.path);
    }
});

// express.serverTiming(), and the two marks it hangs on the response. They are optional, because
// they are only there on a route the middleware ran in front of
expectAssignable<RequestHandler>(express.serverTiming());
expectAssignable<RequestHandler>(express.serverTiming({ routing: false, total: true, name: "app" }));
app.get("/timed", async (_req, res) => {
    res.timing?.("cache", undefined, "miss");
    res.timing?.("db", 3.2);
    const rows = await res.time?.("query", async () => [1, 2, 3]);
    expectAssignable<number[] | undefined>(rows);
    res.json(rows);
});

// the websocket types are importable rather than only reachable through ReturnType, which is what
// an application wrapping app.ws() in its own helper needs
const wsApp: express.FulmineApplication = express();
const behavior: express.FulmineWebSocketBehavior = {
    upgrade(req: Request, res: Response) {
        expectType<string>(req.path);
        expectType<boolean>(res.headersSent);
    },
    open(ws: express.FulmineSocket) {
        expectType<Request>(ws.req);
    }
};
wsApp.ws("/typed", behavior);

// an upgrade hook narrows the request to the one it decorates, and reads it back off the socket:
// the documented way to keep per-connection state, which has to typecheck
type RoomRequest = Request & { roomId: string };
type RoomSocket = express.FulmineSocket & { req: RoomRequest };
wsApp.ws("/room/:id", {
    upgrade(req: RoomRequest, res) {
        expectType<boolean | undefined>(res.aborted);
        req.roomId = String(req.params.id);
    },
    open(ws: RoomSocket) {
        expectType<string>(ws.req.roomId);
    }
});

// the app answers as an http.Server, and the members that surface adds are declared: a shutdown
// path calling app.close() had no type for it
expectType<boolean>(app.listening);
expectAssignable<{ address: string; family: string; port: number } | null>(app.address());
expectType<number>(app.keepAliveTimeout);
app.close((error) => {
    expectType<Error | undefined>(error);
});

// ---------------------------------------------------------------------------
// Everything this project adds to Express, asserted rather than assumed. What
// went missing before was never the Express half: it was a member the runtime
// had and the declarations did not, or a declaration nothing here ever used.
// ---------------------------------------------------------------------------

// the settings object, every field of it
express({ uwsOptions: { key_file_name: "key.pem", cert_file_name: "cert.pem" } });
express({ threads: 4 });
express({ cluster: true });
express({ cluster: 2 });
express({ cluster: "auto" });
express({ http3: true });
express({ uwsApp: app.uwsApp });
expectError(express({ threads: "four" }));
expectError(express({ cluster: "every" }));
expectError(express({ nonsense: true }));

// the four listen shapes, and what they hand back
const server1 = app.listen();
const server2 = app.listen(3000);
const server3 = app.listen("3000", "0.0.0.0");
const server4 = app.listen(3000, "0.0.0.0", 511, (error) => {
    expectType<Error | undefined>(error);
});
expectType<uWS.TemplatedApp>(server1.uwsApp);
expectAssignable<Server>(server2);
expectAssignable<Server>(server3);
expectAssignable<Server>(server4);
expectError(app.listen(true));

// the app is a node request handler, which is how http.createServer(app) and supertest take it
declare const nodeRequest: import("http").IncomingMessage;
declare const nodeResponse: import("http").ServerResponse;
app(nodeRequest, nodeResponse);
app(nodeRequest, nodeResponse, (err?: unknown) => void err);

// the rest of the server surface
expectType<void>(
    app.getConnections((error, count) => {
        expectType<Error | null>(error);
        expectType<number>(count);
    })
);
expectAssignable<typeof app>(app.ref());
expectAssignable<typeof app>(app.unref());
expectAssignable<typeof app>(app.setTimeout(1000, () => undefined));
expectType<number>(app.timeout);
expectType<number>(app.headersTimeout);
expectType<number>(app.requestTimeout);
expectType<number | null>(app.maxHeadersCount);
expectType<number>(app.maxRequestsPerSocket);

// publish and the subscriber count, which are µWS's and only reachable from the app
expectType<boolean>(app.publish("room", "hello"));
expectType<boolean>(app.publish("room", Buffer.from("hello"), true, false));
expectType<number>(app.numSubscribers("room"));

// ws() answers the app or the router it was called on, so it chains
expectAssignable<typeof app>(app.ws("/chain", { open: () => undefined }));
const wsRouter = express.Router();
expectAssignable<typeof wsRouter>(wsRouter.ws("/lobby", { open: () => undefined }));

// the behaviour is µWS's own, settings included
app.ws("/tuned", {
    idleTimeout: 120,
    maxPayloadLength: 16 * 1024 * 1024,
    maxBackpressure: 64 * 1024,
    sendPingsAutomatically: true,
    async message(ws, message, isBinary) {
        expectType<ArrayBuffer>(message);
        expectType<boolean>(isBinary);
        await Promise.resolve();
        ws.send(message, isBinary);
    },
    subscription(ws, topic, newCount, oldCount) {
        expectType<ArrayBuffer>(topic);
        expectType<number>(newCount);
        expectType<number>(oldCount);
        expectType<Request>(ws.req);
    }
});
expectError(app.ws("/typo", { opened: () => undefined }));
expectError(app.ws("/typo", { open: 5 }));

// express.testing, which the comparison suite uses to pin what compiled
const verdicts = express.testing.routeReport(app);
expectType<string>(verdicts[0].method);
expectType<string>(verdicts[0].path);
expectType<boolean>(verdicts[0].native);
expectType<void>(express.testing.expectNative(app, "/users/*"));
expectType<void>(express.testing.expectDeclarative(app, ["/a", "/b"]));
expectError(express.testing.expectNative(app));

// express.compression(), which express has no counterpart for
expectAssignable<RequestHandler>(express.compression());
expectAssignable<RequestHandler>(
    express.compression({
        threshold: "1kb",
        enforceEncoding: "identity",
        encodings: ["gzip", "deflate"],
        brotli: { chunkSize: 1024 },
        filter: (req, res) => {
            expectType<Request>(req);
            expectType<Response>(res);
            return true;
        }
    })
);
expectType<boolean>(express.compression.filter({} as Request, {} as Response));

// and the marks express.serverTiming() hangs on the response
app.get("/timing", (_req, res) => {
    res.timing?.("db", 12, "query");
    expectType<string | undefined>(res.time?.("work", () => "done"));
});

// a check on the checks: these must be the shapes the runtime really has, so each is a member the
// surface diff against express found. When one of them disappears from src/, this file stops
// compiling rather than going quietly green.
expectError(app.publish());
expectError(app.numSubscribers());
expectError(app.address(1));
