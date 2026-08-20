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
        connections: 200,
        // µWS loses a response written from a later tick once the next pipelined request on that
        // connection has been parsed, and a body this size is compressed on the thread pool, so
        // every answer here is written from a later tick. At pipelining 10 the server answered
        // nothing at all and this row read as broken. Checked on a bare µWebSockets.js
        // application with none of this project in it, and it does the same, so it is not
        // something a change here can fix: express answers all of them. Reported upstream as
        // uNetworking/uWebSockets.js#1301.
        pipelining: 1
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
