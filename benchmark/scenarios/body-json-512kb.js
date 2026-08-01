"use strict";

// The other body-parser scenario posts 57 bytes, which uWS hands over in a single
// chunk, so it never exercises the accumulate path. This one is large enough to
// arrive in several chunks and makes the cost of collecting a body visible.
const PAD = 512 * 1024;

module.exports = {
    name: "middlewares/body-json-512kb",
    path: "/abc",
    bound: {
        by: "JSON.parse and utf8 decode of a 512 KiB body, which both frameworks hand to the same V8 primitive",
        ceiling: "~1.02x"
    },
    wrk: {
        script: "post-json-512kb.lua",
        connections: 50
    },
    verify: {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ n: 1, pad: "x".repeat(PAD) })
    },
    setup(app, express) {
        app.use(express.json({ limit: "10mb" }));
        app.post("/abc", (req, res) => {
            res.send(`${req.body.pad.length}`);
        });
    }
};
