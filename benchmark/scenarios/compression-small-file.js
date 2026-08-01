"use strict";

const compression = require("compression");

module.exports = {
    name: "middlewares/compression-file",
    path: "/small-file",
    bound: {
        by: "zlib deflate through the same compression middleware on both sides"
    },
    load: {
        connections: 200
    },
    request: {
        method: "GET",
        headers: {
            "Accept-Encoding": "gzip"
        }
    },
    setup(app, express, context) {
        app.use(compression());
        app.get("/small-file", (req, res) => {
            res.type("text/plain").send(context.compressedPayload);
        });
    }
};
