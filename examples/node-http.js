// The app is a request listener like Express's, so http.createServer(app) works, and with it
// supertest, vhost and anything else that calls an app. Node serves these requests, not µWS: it is
// for compatibility, not for speed. On Bun and Deno, app.listen() takes this path by itself.
//
//   node node-http.js
//   curl http://localhost:3000/
const http = require("node:http");
const express = require("fulmine.js"); // instead of require("express")

const app = express();

// isFulmine is true here and undefined on Express, for code that runs on both
app.get("/", (req, res) => {
    res.send(express.isFulmine ? "fulmine.js through node:http" : "express");
});

http.createServer(app).listen(3000, () => console.log("http://localhost:3000/"));
