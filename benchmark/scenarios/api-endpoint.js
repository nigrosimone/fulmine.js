"use strict";

// The suite had no scenario shaped like an actual API endpoint: `grep -r "res.json\|req.params\|req.query"`
// over benchmark/scenarios returned nothing. That is the most common request shape in an Express
// application, and the one where the framework's own work is a meaningful share of the request
// rather than a rounding error next to zlib or JSON.parse.
// The headers are here because a request with three of them is not a request. A browser sends a
// dozen or more, and per-header work, of which every server has some, was being measured at a
// quarter of its real weight.
module.exports = {
    name: "routing/api-endpoint",
    path: "/api/users/42/posts?fields=id,title,author&limit=10",
    request: {
        method: "GET",
        headers: {
            Accept: "application/json, text/plain, */*",
            "Accept-Encoding": "gzip, deflate, br",
            "Accept-Language": "en-GB,en;q=0.9,it;q=0.8",
            Authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MiJ9.notarealtoken",
            "Cache-Control": "no-cache",
            Cookie: "session=abc123; theme=dark; consent=1",
            Origin: "https://example.com",
            Referer: "https://example.com/users/42",
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0",
            "X-Request-Id": "0f8fad5b-d9cb-469f-a165-70867728950e",
            "X-Requested-With": "XMLHttpRequest"
        }
    },
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
