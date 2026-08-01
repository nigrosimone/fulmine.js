"use strict";

// Every other scenario runs at 50-200 connections, where connection handling is free. uWS's
// advantage over node:http at high connection counts is structural - per-connection memory and
// accept handling - rather than anything in the request path, and nothing in the suite exercised it.
// The handler is deliberately trivial so the row measures connections and not work.
//
// Caveat: wrk shares the runner with the server, so at this connection count part of what is
// measured is the generator. Two wrk threads on a 4 vCPU runner leaves the server two.
module.exports = {
    name: "connections/high-concurrency",
    path: "/ping",
    load: {
        connections: 1000,
        workers: 2
    },
    setup(app) {
        app.get("/ping", (req, res) => res.send("pong"));
    }
};
