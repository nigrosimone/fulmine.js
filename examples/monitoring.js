// The diagnostics channels Express and node publish, here also when µWS serves the request: what
// Sentry and the other tracers read. Subscribe before listen(), so no route is compiled past them.
//
//   node monitoring.js
//   curl http://localhost:3000/users/7
//   curl http://localhost:3000/fail
const diagnostics = require("node:diagnostics_channel");
const express = require("fulmine.js"); // instead of require("express")

// Express's router channel: a start and an end for every middleware, route handler and error handler
// what the channel hands each hook
/** @typedef {{ req: express.Request, layer: { name: string }, error?: Error }} RouterContext */
const router = /** @type {diagnostics.TracingChannel<object, RouterContext>} */ (
    diagnostics.tracingChannel("express.router.request")
);
router.subscribe({
    start({ req, layer }) {
        console.log("start ", req.method, req.url, layer.name || "<anonymous>");
    },
    end({ layer }) {
        console.log("end   ", layer.name || "<anonymous>");
    },
    error({ error }) {
        console.log("error ", String(error));
    }
});

// node:http's own channel, published by fulmine also on µWS
diagnostics.subscribe("http.server.response.finish", ({ request, response }) => {
    console.log("finish", request.url, response.statusCode);
});

const app = express();

app.use(function logger(req, res, next) {
    next();
});

app.get("/users/:id", function getUser(req, res) {
    res.json({ id: req.params.id });
});

app.get("/fail", function fail() {
    throw new Error("something broke");
});

app.listen(3000, () => console.log("http://localhost:3000/users/7"));
