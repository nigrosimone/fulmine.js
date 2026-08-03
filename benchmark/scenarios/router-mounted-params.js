"use strict";

// routes-1000-params, except the routes live in a Router mounted on the app, which is how an
// application of that size is actually written: routes/users.js, routes/orders.js, one require and
// one app.use each.
//
// The two scenarios measure different things, and the difference is the point. A parameter route
// registered on the app goes to the native µWS router. Inside a mounted router it only goes there
// when nothing registered after it in that router could match the same path, because a native chain
// that runs out resumes after the mount rather than inside the router, and a sibling that would
// have answered next would be lost. In a router full of /:id routes almost every route has such a
// sibling, so almost none of them are native.
//
// The request asks for a route in the middle rather than the last one. The last route has nothing
// after it, so it is the one route in here that does reach µWS, and asking for it would measure the
// one case this scenario exists to contrast with.
const ROUTE_COUNT = 1000;

module.exports = {
    name: "routing/router-mounted-params",
    path: `/api/resource${ROUTE_COUNT / 2}/42/detail`,
    setup(app, express) {
        const router = express.Router();
        for (let i = 0; i < ROUTE_COUNT; i++) {
            router.get(`/resource${i}/:id/detail`, (req, res) => res.send(req.params.id));
        }
        app.use("/api", router);
    }
};
