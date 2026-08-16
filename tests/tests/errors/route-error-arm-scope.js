// an error handler written inside a route catches what that route raised, and nothing else
// INSPECT
//
// Express skips a route layer while an error is in flight, so an error from a middleware before it,
// or out of a mount, walks past to the router's own error handlers. Everything hung off one
// app.route() is a single route there, though, so its siblings do reach each other, while two
// separate app.get() on the same path stay strangers.
// Found by fuzzing express.static against express, where a missing file raised inside the static
// middleware and a later route caught it here and did not there.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// raised before any route matched
app.use((req, res, next) => (req.path === "/outside" ? next(new Error("from middleware")) : next()));
app.get(
    "/outside",
    (req, res) => res.send("never"),
    (err, req, res, next) => res.status(418).send("route arm: " + err.message)
);

// raised by the route itself, which is the one case the arm exists for
app.get(
    "/inside",
    (req, res, next) => next(new Error("from the route")),
    (err, req, res, next) => res.status(418).send("route arm: " + err.message)
);
app.get(
    "/throws",
    () => {
        throw new Error("thrown in the route");
    },
    (err, req, res, next) => res.status(418).send("route arm: " + err.message)
);

// two routes written separately on one path are two routes, and do not reach each other
app.get("/separate", (req, res, next) => next(new Error("from the first")));
app.get("/separate", (err, req, res, next) => res.status(418).send("second route arm: " + err.message));

// everything hung off one app.route() is one route, and does
const grouped = app.route("/grouped");
grouped.all((req, res, next) => next(new Error("from the group")));
grouped.all((req, res) => res.send("never"));
grouped.all((err, req, res, next) => res.status(418).send("group arm: " + err.message));

// and the same question one level down, inside a mounted router
const mounted = express.Router();
mounted.use((req, res, next) => next(new Error("from the router middleware")));
mounted.get(
    "/x",
    (req, res) => res.send("never"),
    (err, req, res, next) => res.status(418).send("router route arm: " + err.message)
);
app.use("/m", mounted);

app.use((err, req, res, next) => res.status(500).send("app arm: " + err.message));
app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/outside", "/inside", "/throws", "/separate", "/grouped", "/m/x"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
