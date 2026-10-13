// what code reading the router from outside finds: the layers of app.router.stack with matchers,
// slash and the params match() fills, handleRequest and handleError, router 2's options as
// properties, "trust proxy fn", rawListeners and the Route app.route() hands back

const express = require("express");

const app = express();
const router = express.Router({ mergeParams: true, caseSensitive: true });
router.get("/x/:id", function rx(req, res) {
    res.end();
});
router.param("id", function pid(req, res, next) {
    next();
});

app.use(function mw(req, res, next) {
    next();
});
app.use("/api", router);
app.get("/users/:id", function user(req, res) {
    res.end();
});
app.get("/files/*rest", function files(req, res) {
    res.end();
});
app.get(/^\/re\/(\d+)$/, function re(req, res) {
    res.end();
});
const books = app.route("/books").get(function list(req, res) {
    res.end();
});

const PATHS = [
    "/",
    "/api",
    "/api/x/1",
    "/apix",
    "/users/42",
    "/users/42/",
    "/USERS/a%20b",
    "/files/a/b",
    "/re/7",
    "/books"
];
for (const layer of app.router.stack) {
    console.log("layer", layer.name, "slash", layer.slash, "matchers", layer.matchers.length);
    for (const path of PATHS) {
        const matched = layer.match(path);
        console.log(
            " ",
            path,
            matched,
            JSON.stringify(layer.path),
            JSON.stringify(layer.params),
            JSON.stringify(layer.keys),
            JSON.stringify(layer.matchers[0](path))
        );
    }
    console.log("  null", layer.match(null), JSON.stringify(layer.path));
}
for (const layer of books.stack) {
    console.log(
        "route layer",
        layer.name,
        layer.method,
        layer.slash,
        ["", "/", "//", "/x"].map((p) => layer.match(p))
    );
}

// handleRequest and handleError as router 2 runs them
/** @param {any} layer @param {...any} args */
function run(label, layer, method, ...args) {
    return new Promise((resolve) => {
        const next = (/** @type {any} */ err) => {
            console.log(
                label,
                "next",
                err === undefined ? "undefined" : err instanceof Error ? err.message : String(err)
            );
            resolve();
        };
        layer[method](...args, {}, {}, next);
        setTimeout(resolve, 20);
    });
}
const Layer = app.router.stack[0].constructor;
const make = (/** @type {Function} */ fn) => {
    const layer = Object.create(Layer.prototype);
    layer.handle = fn;
    return layer;
};

(async () => {
    await run(
        "throws",
        make(() => {
            throw new Error("thrown");
        }),
        "handleRequest"
    );
    await run(
        "rejects",
        make(() => Promise.reject(new Error("rejected"))),
        "handleRequest"
    );
    await run(
        "rejects empty",
        make(() => Promise.reject()),
        "handleRequest"
    );
    await run(
        "error handler skipped",
        make((err, req, res, next) => next()),
        "handleRequest"
    );
    await run(
        "plain skipped",
        make((req, res, next) => next("never")),
        "handleError",
        new Error("in")
    );
    await run(
        "error handler",
        make((err, req, res, next) => next(err)),
        "handleError",
        new Error("in")
    );

    console.log(
        "router",
        router.caseSensitive,
        router.strict,
        router.mergeParams,
        Object.keys(router.params),
        router.params.id.length
    );
    const plain = express.Router();
    console.log("plain router", plain.caseSensitive, plain.strict, plain.mergeParams, JSON.stringify(plain.params));
    console.log("app router", app.router.caseSensitive, app.router.strict, app.router.mergeParams);

    console.log("trust proxy fn", typeof app.get("trust proxy fn"), app.get("trust proxy fn")("10.0.0.1", 0));
    app.set("trust proxy", "loopback");
    console.log(
        "trust proxy fn loopback",
        app.get("trust proxy fn")("127.0.0.1", 0),
        app.get("trust proxy fn")("10.0.0.1", 0)
    );

    app.on("custom", () => {});
    app.once("custom", () => {});
    console.log("rawListeners", app.rawListeners("custom").length, typeof app.rawListeners("custom")[1]);

    console.log("Router.Route", express.Router.Route === express.Route);
    console.log(
        "app.route()",
        books instanceof express.Route,
        books._methods(),
        books._handlesMethod("HEAD"),
        books._handlesMethod("POST"),
        typeof books.dispatch
    );
    process.exit(0);
})();
