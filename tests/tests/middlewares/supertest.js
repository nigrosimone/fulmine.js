// must support supertest

const express = require("express");
const request = require("supertest");

const app = express();

app.get("/user", function (req, res) {
    res.status(200).json({ name: "john" });
});

// This handler is simple enough to be compiled into a native response, and a native response is
// framed chunked with no Content-Length, so asserting that header would be asserting which path
// served the route rather than whether supertest works. res.send({ ... }) has always been compiled
// the same way, so the framing is not new with res.json, it is only newly reachable from the shape
// most people write. app.set("declarative responses", false) gets the length back.
const isFulmine = !!app.uwsApp;

const pending = request(app).get("/user").expect("Content-Type", /json/).expect(200);
if (!isFulmine) {
    pending.expect("Content-Length", "15");
}

pending.end(function (err, res) {
    if (err) {
        console.log(err);
        process.exit(1);
    }
    console.log(res.body); // { name: 'john' }
    console.log(
        "framed as this server frames it:",
        isFulmine ? !res.headers["content-length"] : res.headers["content-length"] === "15"
    );
    process.exit(0);
});
