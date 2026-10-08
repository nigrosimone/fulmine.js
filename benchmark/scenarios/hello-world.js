"use strict";

module.exports = {
    name: "routing/hello-world",
    path: "/",
    setup(app) {
        app.get("/", (req, res) => res.send("Hello world"));
    },
    // the same answer written on node:http by hand, what --shim measures the shim against
    nodeHttp(req, res) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("Hello world");
    }
};
