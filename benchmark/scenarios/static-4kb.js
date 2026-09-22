"use strict";

const fs = require("fs");
const path = require("path");

// the shape of a CDN-less asset route and of HttpArena's static profile: a small file through
// express.static, answered from the sendFile cache, where per-request overhead is most of the bill
module.exports = {
    name: "middlewares/express-static-small",
    path: "/static/static-4kb.txt",
    load: {
        // answered from a later tick, uWS loses it when pipelined (uNetworking/uWebSockets.js#1301):
        // 233 req/s at pipelining 10, 36229 at 1, p50 1.2s. Only ab.js and profile.js read this
        pipelining: 1
    },
    setup(app, express, context) {
        context.ensureAssets();
        const file = path.join(context.assetsDir, "static-4kb.txt");
        if (!fs.existsSync(file)) {
            fs.writeFileSync(file, Buffer.alloc(4096, "a"));
        }
        app.use("/static", express.static(context.assetsDir));
    }
};
