"use strict";

const list = require("./scenarios/json-list.js");

// Reuse the list handler and dataset, changing only the route registration. Each request still
// builds its own items and serializes them; neither the JSON nor its compressed bytes are cached.
module.exports = function liteJson({ name, count, encoding, compress = true }) {
    return {
        name: `uws-lite/json-${name}`,
        path: `/json/${count}?m=3`,
        request: {
            headers: encoding === undefined ? {} : { "Accept-Encoding": encoding }
        },
        setup(app, express) {
            const lite = app.uwsLite;
            list.setup({
                get(path, handler) {
                    if (lite) {
                        lite.get(path, { compress }, handler);
                    } else if (compress) {
                        const compression = express.compression || require("compression");
                        app.get(path, compression(), handler);
                    } else {
                        app.get(path, handler);
                    }
                }
            });
        }
    };
};
