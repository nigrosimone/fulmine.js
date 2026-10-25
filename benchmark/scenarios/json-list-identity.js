"use strict";

// JSON behind compression middleware when the client sends no Accept-Encoding,
// as in HttpArena's json-tls workload. This measures the application path over
// plain HTTP; it does not reproduce TLS, the rotated dataset, or the full profile.
const list = require("./json-list.js");

module.exports = {
    name: "middlewares/json-list-identity",
    path: list.path,
    setup(app, express) {
        const compression = express.compression || require("compression");
        app.use(compression());
        list.setup(app);
    }
};
