"use strict";

// routes-1000 with a parameter in every route, which is what an API of any size actually looks
// like: /orders/:id, /users/:id/posts, /projects/:id/members, a few hundred of them.
//
// The static version of this scenario cannot show what that costs. Every one of its routes goes to
// the native µWS router, so there is no scan left to measure. A route with a parameter went the
// slow way until 2026-08-02, which meant the catch-all handler and a walk through the route table
// comparing regular expressions, once per request, for every route registered before the one that
// matched.
//
// The request asks for the last route on purpose. Asking for the first would measure a scan that
// stops immediately, which is the case that was never the problem.
const ROUTE_COUNT = 1000;

module.exports = {
    name: "routing/routes-1000-params",
    path: `/resource${ROUTE_COUNT - 1}/42/detail`,
    setup(app) {
        for (let i = 0; i < ROUTE_COUNT; i++) {
            app.get(`/resource${i}/:id/detail`, (req, res) => res.send(req.params.id));
        }
    }
};
