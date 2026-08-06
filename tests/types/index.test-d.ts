import { expectType, expectAssignable } from "tsd";
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
// overloads that hand back a uWS listen token.
const configured = express({
    threads: 2,
    http3: false,
    uwsOptions: { key_file_name: "key.pem", cert_file_name: "cert.pem" }
});
expectType<uWS.TemplatedApp>(configured.uwsApp);

const withToken = configured.listen(3000, (token) => {
    expectType<any>(token);
});
expectType<uWS.TemplatedApp>(withToken.uwsApp);
withToken.close();

expectAssignable<Server>(configured.listen(3000, "127.0.0.1"));
expectAssignable<Server>(configured.listen((_token) => {}));

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
NamedRouter().ws("/lobby", { open: (ws) => ws.send(ws.req.path) });
