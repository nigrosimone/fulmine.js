"use strict";

// HttpArena's baseline row, the POST half of it. That profile rotates GET, POST with a
// Content-Length and POST chunked in equal parts, so two requests in three carry a body, and the
// body is two bytes: what it measures is the machinery around a body, never the copying of one.
//
// It sits here because that row is the widest gap on the board, 53us of CPU per request against
// uWebSockets.js's 27, and the suite had nothing shaped like it: the other POST scenarios all go
// through a body parser, and this handler reads the stream itself, the way the arena entry does.
module.exports = {
    name: "routing/arena-baseline-post",
    path: "/baseline11?a=13&b=42",
    request: {
        method: "POST",
        body: "20"
    },
    setup(app) {
        app.post("/baseline11", (req, res) => {
            let sum = 0;
            for (const k in req.query) {
                const n = parseInt(req.query[k], 10);
                if (n === n) sum += n;
            }
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
                const n = parseInt(body.trim(), 10);
                if (n === n) sum += n;
                res.type("text/plain").send(String(sum));
            });
        });
    }
};
