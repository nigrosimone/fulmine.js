"use strict";

module.exports = {
    name: "streaming/writable-no-content-length",
    path: "/stream-without-content-length",
    bound: {
        by: "loopback bandwidth for a 5 MiB response, so nearly all of the budget is per-byte copying",
        ceiling: "~1.01x"
    },
    load: {
        connections: 50
    },
    setup(app, express, context) {
        app.get("/stream-without-content-length", (req, res) => {
            context.pipeLargeStream(res, false);
        });
    }
};
