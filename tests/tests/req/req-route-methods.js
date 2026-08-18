// req.route is the route's own, and it carries the verbs and the layers of the route
//
// Express sets it inside Route#dispatch, so a middleware and a request nothing routed read
// undefined there. That is what a metrics or tracing middleware asks when it names a request after
// the route rather than after the url. The methods map is not one shape either: app.all() names
// every verb, router.all() and app.route().all() mark the route _all, and everything hung off one
// app.route() shares one map, since express builds one route for the lot. Several paths at once
// are one route as well, whose path is the array, and app.route() hands that route back.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);

/** @param {any} layer one entry of the route's stack */
const layer = (layer) => ({
    name: layer.name,
    method: layer.method === undefined ? "(none)" : layer.method,
    keys: layer.keys,
    handle: typeof layer.handle
});

/** @param {any} route */
const shape = (route) =>
    route === undefined ? "undefined" : { path: route.path, methods: route.methods, stack: route.stack.map(layer) };

// named on purpose: express takes a layer's name from the handler it was given
function answer(req, res) {
    res.json(shape(req.route));
}

// before any route, where express has none
app.use("/mounted", (req, res, next) => {
    res.set("X-Route-In-Middleware", JSON.stringify(shape(req.route)));
    next();
});
app.get("/mounted/:id", answer);

app.all("/every-verb", answer);

// two handlers, which are two layers of the same route
app.get("/two-handlers", answer, (req, res) => res.json(shape(req.route)));

// several paths at once, which express registers as one route whose path is the array
app.get(["/multi-a", "/multi-b"], answer);

const router = express.Router();
router.all("/router-all", answer);
router.get("/router-get", answer);
app.use("/r", router);

// registered with a trailing slash and matched without one, since strict routing is off: express
// keeps the path as it was written and hands that back
app.get("/written/", answer);

const chained = app.route("/chained");
chained.get(answer);
chained.post((req, res) => res.json(shape(req.route)));
// what app.route() itself hands back, which express builds as a route rather than as a bag of
// verb methods
console.log(
    "app.route():",
    JSON.stringify({ path: chained.path, methods: chained.methods, stack: chained.stack.map(layer) })
);

// and a request nothing routed, which reads undefined as well
app.use((req, res) => res.status(404).json(shape(req.route)));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const asked = [
        ["GET", "/mounted/7"],
        ["PUT", "/every-verb"],
        ["PUT", "/r/router-all"],
        ["GET", "/r/router-get"],
        ["GET", "/two-handlers"],
        ["GET", "/multi-a"],
        ["GET", "/multi-b"],
        ["GET", "/written/"],
        ["GET", "/written"],
        ["GET", "/chained"],
        ["POST", "/chained"],
        ["GET", "/nothing-here"]
    ];

    const answers = await sequential(
        asked.map(
            ([method, path]) =>
                () =>
                    fetchTest(`http://localhost:13333${path}`, { method })
        )
    );

    for (const [i, res] of answers.entries()) {
        console.log(asked[i][0], asked[i][1], res.headers.get("x-route-in-middleware"), await res.text());
    }

    process.exit(0);
});
