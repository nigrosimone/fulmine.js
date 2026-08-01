"use strict";

module.exports = {
    name: "streaming/writable-with-content-length",
    path: "/stream-with-content-length",
    bound: {
        by: "loopback bandwidth for a 5 MiB response, so nearly all of the budget is per-byte copying",
        ceiling: "~1.01x"
    },
    wrk: {
        connections: 50
    },
    setup(app, express, context) {
        app.get("/stream-with-content-length", (req, res) => {
            context.pipeLargeStream(res, true);
        });
    }
};
