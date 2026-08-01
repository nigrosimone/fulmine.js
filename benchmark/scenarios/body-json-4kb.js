"use strict";

// body-json-512kb is a stress case: at half a megabyte JSON.parse dominates and the framework is
// about 1% of the request, so that row cannot move. A few KB is what an API actually receives, and
// at that size the body plumbing around the parse is visible. Both rows are kept - one measures the
// parser, this one measures getting the bytes to it.
const PAD = 4 * 1024;

module.exports = {
    name: "middlewares/body-json-4kb",
    path: "/abc",
    load: {
        connections: 200
    },
    request: {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ n: 1, pad: "x".repeat(PAD) })
    },
    setup(app, express) {
        app.use(express.json());
        app.post("/abc", (req, res) => {
            res.send(`${req.body.pad.length}`);
        });
    }
};
