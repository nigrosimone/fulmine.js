"use strict";

// The Body test of SaltyAom's bun-http-framework-benchmark: a 25-byte JSON body through the
// stock json middleware, echoed back with res.json. At this size JSON.parse is nothing and the
// row measures the plumbing around it: the content-type gate, the body collection, the parse
// wrapper and the echo. The local ceiling measured for this shape is raw uWS at ~25.8k against
// our 16.3k, which is the gap this scenario exists to close.
module.exports = {
    name: "middlewares/body-json-echo",
    path: "/json",
    request: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{\n    "hello": "world"\n}'
    },
    setup(app, express) {
        app.post("/json", express.json(), (req, res) => {
            res.json(req.body);
        });
    }
};
