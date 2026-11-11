// Inversify: a controller served by @inversifyjs/http-express, with the arm's app handed to the
// adapter as `customApp`. That is the whole integration, the adapter registers its routes on it.
//
// The controller covers query, path and header parameters, a body, a guard that refuses, a 404 as
// an HttpResponse, @StatusCode, @SetHeader, a text reply and a stream reply. Decorators are applied
// by hand, as in nest.js.

require("reflect-metadata");
const { Readable } = require("stream");
const { Container } = require("inversify");
const {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    HttpStatusCode,
    NotFoundHttpResponse,
    Params,
    Post,
    Query,
    SetHeader,
    StatusCode,
    UseGuard
} = require("@inversifyjs/http-core");
const { InversifyExpressHttpAdapter } = require("@inversifyjs/http-express");
const { express } = require("../arm.js");
const { fetchTest, sequential } = require("../../tests/helpers.js");

const PORT = 13813;

/** Applies a method decorator the way the TypeScript emit would, descriptor included. */
function method(target, key, decorator) {
    const descriptor = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(target.prototype, key));
    decorator(target.prototype, key, descriptor);
    Object.defineProperty(target.prototype, key, descriptor);
}

/** Applies a parameter decorator, which takes the position rather than a descriptor. */
function param(target, key, index, decorator) {
    decorator(target.prototype, key, index);
}

/** Lets a request through only with the right token. */
class TokenGuard {
    activate(request) {
        return request.headers["x-token"] === "secret";
    }
}

class ItemsController {
    constructor() {
        this.items = [{ id: 1, name: "primo" }];
    }

    find(prefix) {
        return this.items.filter((item) => !prefix || item.name.startsWith(prefix));
    }

    one(id, trace) {
        const item = this.items.find((x) => x.id === Number(id));
        if (!item) throw new NotFoundHttpResponse({ message: `no item ${id}` });
        return { ...item, trace: trace ?? null };
    }

    create(body) {
        const item = { id: this.items.length + 1, name: body.name };
        this.items.push(item);
        return item;
    }

    remove(id) {
        return this.items.splice(
            this.items.findIndex((x) => x.id === Number(id)),
            1
        )[0];
    }

    hello() {
        return "hello from inversify";
    }

    stream() {
        return Readable.from(["one ", "two ", "three"]);
    }
}

param(ItemsController, "find", 0, Query({ name: "prefix" }));
param(ItemsController, "one", 0, Params({ name: "id" }));
param(ItemsController, "one", 1, Headers({ name: "x-trace" }));
param(ItemsController, "create", 0, Body());
param(ItemsController, "remove", 0, Params({ name: "id" }));
method(ItemsController, "find", Get("/"));
method(ItemsController, "hello", Get("/text/hello"));
method(ItemsController, "stream", Get("/text/stream"));
method(ItemsController, "one", Get("/:id"));
method(ItemsController, "create", Post("/"));
method(ItemsController, "create", StatusCode(HttpStatusCode.CREATED));
method(ItemsController, "create", SetHeader("x-made", "yes"));
method(ItemsController, "remove", Delete("/:id"));
method(ItemsController, "remove", UseGuard(TokenGuard));
Controller("/items")(ItemsController);

/** GETs a path and prints the answer. */
function get(path, headers) {
    return async () => console.log(await (await fetchTest(`http://localhost:${PORT}${path}`, { headers })).text());
}

/** Sends a method with an optional JSON body and prints the answer. */
function send(method, path, body, headers) {
    return async () => {
        const response = await fetchTest(`http://localhost:${PORT}${path}`, {
            method,
            headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined
        });
        console.log(await response.text());
    };
}

async function main() {
    const container = new Container();
    container.bind(ItemsController).toSelf().inSingletonScope();
    container.bind(TokenGuard).toSelf();

    // with customApp the adapter adds no body parser of its own
    const app = express();
    app.use(express.json());
    await new InversifyExpressHttpAdapter(container, { logger: false }, app).build();

    const server = app.listen(PORT, async () => {
        await sequential([
            get("/items"),
            get("/items?prefix=p"),
            get("/items/1", { "x-trace": "abc" }),
            get("/items/99"),
            send("POST", "/items", { name: "secondo" }),
            get("/items/text/hello"),
            get("/items/text/stream"),
            // the guard refuses without the token, then lets it through
            send("DELETE", "/items/2"),
            send("DELETE", "/items/2", undefined, { "x-token": "secret" }),
            get("/items"),
            // nothing registered here, Express's own 404
            get("/nothing")
        ]);
        // closing lets the process end on its own: process.exit with µWS still listening aborts on Windows
        server.close();
    });
}

main();
