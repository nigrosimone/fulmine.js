"use strict";

// The other half of HttpArena's baseline row: same route and same query, no body. Read next to
// arena-baseline-post it says how much of that row is the request and response objects and the
// routing, and how much is the body stream the POST half sets up.
module.exports = {
    name: "routing/arena-baseline-get",
    path: "/baseline11?a=13&b=42",
    setup(app) {
        app.get("/baseline11", (req, res) => {
            let sum = 0;
            for (const k in req.query) {
                const n = parseInt(req.query[k], 10);
                if (n === n) sum += n;
            }
            res.type("text/plain").send(String(sum));
        });
    }
};
