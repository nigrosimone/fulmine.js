"use strict";

// The suite had no scenario shaped like an actual API endpoint: `grep -r "res.json\|req.params\|req.query"`
// over benchmark/scenarios returned nothing. That is the most common request shape in an Express
// application, and the one where the framework's own work is a meaningful share of the request
// rather than a rounding error next to zlib or JSON.parse.
module.exports = {
    name: "routing/api-endpoint",
    path: "/api/users/42/posts?fields=id,title,author&limit=10",
    setup(app, express) {
        const apiRouter = express.Router();

        apiRouter.get("/users/:userId/posts", (req, res) => {
            const fields = String(req.query.fields || "").split(",");
            const limit = Number(req.query.limit) || 0;
            const items = [];
            for (let i = 0; i < limit; i++) {
                items.push({ id: i, title: `post ${i}`, author: req.params.userId });
            }

            res.json({
                userId: req.params.userId,
                fields,
                count: items.length,
                items
            });
        });

        app.use("/api", apiRouter);
    }
};
