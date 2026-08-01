"use strict";

module.exports = {
    name: "streaming/readable-hash-4mb",
    path: "/hash-body",
    bound: {
        by: "OpenSSL sha256 over a 4 MiB body, which is most of the per-request budget",
        ceiling: "~1.1x-1.4x"
    },
    load: {
        connections: 50
    },
    request: {
        method: "POST",
        headers: {
            "Content-Type": "application/octet-stream"
        },
        bodyRepeat: {
            char: "a",
            count: 4 * 1024 * 1024
        }
    },
    setup(app, express, context) {
        app.post("/hash-body", (req, res, next) => {
            context.createHashFromRequest(req, (digest, error) => {
                if (error) {
                    next(error);
                    return;
                }
                res.type("text/plain").send(digest);
            });
        });
    }
};
