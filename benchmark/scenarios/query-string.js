"use strict";

// A list endpoint with the query a real one carries: a term, a page and a size. It exists because
// this suite had almost none: of the other scenarios only api-endpoint and api-mixed put anything
// after the "?", so a change that cost every req.query read four percent shipped through CI without
// moving a single row. A public benchmark whose baseline sends "?a=13&b=42" on every request saw it
// the same day.
//
// Three parameters and three reads, which is the shape that made the difference visible: the cost
// of req.query is paid per read, not per request.
module.exports = {
    name: "routing/query-string",
    path: "/search?q=fulmine&page=2&limit=20",
    setup(app) {
        app.get("/search", (req, res) => {
            const term = String(req.query.q ?? "");
            const page = Number(req.query.page) || 1;
            const limit = Math.min(Number(req.query.limit) || 10, 50);
            res.json({ term, page, limit, offset: (page - 1) * limit });
        });
    }
};
