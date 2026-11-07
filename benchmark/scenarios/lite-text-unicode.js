"use strict";

// 768 UTF-16 code units, 1216 UTF-8 bytes: compression uses the byte length.
const BODY = "Città 東京 😀 ".repeat(64);

module.exports = {
    name: "uws-lite/text-unicode",
    path: "/unicode",
    request: {
        headers: { "Accept-Encoding": "br" }
    },
    setup(app, express) {
        const handler = (req, res) => res.type("text/plain").send(BODY);
        if (app.uwsLite) {
            app.uwsLite.get("/unicode", { compress: true }, handler);
        } else {
            const compression = express.compression || require("compression");
            app.get("/unicode", compression(), handler);
        }
    }
};
