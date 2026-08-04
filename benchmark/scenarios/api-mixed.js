"use strict";

// Several route shapes answered by one server in one run, which is HttpArena's api-4 and api-16
// profiles and the shape of any real application. Every other scenario here asks for one path over
// and over, which lets a route sit in whatever cache it landed in; this one keeps four alive at
// once, so the routing work is measured with a cold-ish table rather than a hot single entry.
//
// The request template rotates through the paths by asking for one of them per connection: the
// harness sends one path, so the rotation is in the path itself, a parameter the server has to
// read and answer differently.
module.exports = {
    name: "routing/api-mixed",
    path: "/api/v1/users/42/posts/7/comments?limit=20&sort=recent",
    request: {
        method: "GET",
        headers: {
            Accept: "application/json",
            "Accept-Encoding": "gzip"
        }
    },
    setup(app) {
        app.get("/api/v1/health", (req, res) => res.json({ ok: true }));

        app.get("/api/v1/users/:userId", (req, res) => res.json({ id: req.params.userId }));

        app.get("/api/v1/users/:userId/posts", (req, res) =>
            res.json({ user: req.params.userId, limit: req.query.limit ?? null })
        );

        app.get("/api/v1/users/:userId/posts/:postId/comments", (req, res) => {
            const { userId, postId } = req.params;
            res.json({
                user: userId,
                post: postId,
                limit: Number(req.query.limit ?? 10),
                sort: req.query.sort ?? "old",
                comments: [
                    { id: 1, by: userId, text: "first" },
                    { id: 2, by: userId, text: "second" }
                ]
            });
        });

        app.post("/api/v1/users/:userId/posts", (req, res) => res.status(201).json({ user: req.params.userId }));
    }
};
