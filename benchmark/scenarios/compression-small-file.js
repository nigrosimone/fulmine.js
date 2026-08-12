"use strict";

// Each arm compresses with the middleware it would actually use: express.compression() on Fulmine,
// the compression module on Express, which has none of its own. The two take the same options and
// answer the same headers, so what this row measures is how the same feature is implemented, the
// way static-4kb measures express.static() rather than serve-static.
const compressionModule = require("compression");

module.exports = {
    name: "middlewares/compression-file",
    path: "/small-file",
    bound: {
        by: "zlib deflate of the same payload, which both middlewares hand to the same library"
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
        const compression = express.compression || compressionModule;
        app.use(compression());
        app.get("/small-file", (req, res) => {
            res.type("text/plain").send(context.compressedPayload);
        });
    }
};
