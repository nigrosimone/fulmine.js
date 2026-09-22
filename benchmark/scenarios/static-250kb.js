"use strict";

module.exports = {
    name: "middlewares/express-static",
    path: "/static/static-250kb.txt",
    load: {
        // streamed from a later tick, so pipelined, µWS loses the answers the way
        // compression-small-file describes (uNetworking/uWebSockets.js#1301): 242 req/s at
        // pipelining 10 against 6633 at 1. Only ab.js and profile.js read this
        pipelining: 1
    },
    setup(app, express, context) {
        context.ensureAssets();
        app.use("/static", express.static(context.assetsDir));
    }
};
