// must support supertest

const express = require("express");
const request = require("supertest");

const app = express();

app.get("/user", function (req, res) {
    res.status(200).json({ name: "john" });
});

// No special case any more, and that is the point of it being here.
//
// request(app) reads `typeof app === "function"` and wraps the app in http.createServer, so on both
// frameworks this request is served through node's own HTTP server. Both therefore frame it the
// same way, with a Content-Length, and this can assert the header rather than asserting which path
// happened to serve the route. Before src/node-shim.js there was nothing under a fulmine app that
// could answer node's IncomingMessage, so this file had to know which framework it was running on.
request(app)
    .get("/user")
    .expect("Content-Type", /json/)
    .expect("Content-Length", "15")
    .expect(200)
    .end(function (err, res) {
        if (err) {
            console.log(err);
            process.exit(1);
        }
        console.log(res.body); // { name: 'john' }
        console.log("content-length:", res.headers["content-length"]);
        process.exit(0);
    });
