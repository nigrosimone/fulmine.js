// which next res.format hands over, and where its 406 goes from inside a route
//
// The companion to route-arm-and-req-next.js, for the third method that reports to the router's
// next rather than the route's. A 406 raised by res.format leaves the route, so a four argument
// handler written inside that route does not catch it.
//
// This was the hard half of that question. Express's own res.format test asserts the handler is
// given the very object the surrounding layer received, and those asserts are all inside a use()
// with a single callback, where leaving the route and stepping to the next callback are the same
// step with two different objects here. They are made the same object there, see Walk#runRoute,
// which is what lets this hand over the router's next everywhere without failing those four tests.
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const caught = (err, req, res, next) => res.status(418).json({ hit: "the route's own arm", status: err.status });

// nothing here can answer text/plain, so format has to raise the 406
app.get("/in-a-route", (req, res) => res.format({ json: () => res.send("json") }), caught);

// the same without an arm of its own, where the two never disagreed
app.get("/plain", (req, res) => res.format({ json: () => res.send("json") }));

// the identity express asserts: the handler is given the next this layer received
app.use("/identity", (req, res, next) => {
    res.format({
        default: (rq, rs, given) => rs.json({ same: given === next })
    });
});

// and the same identity inside a route, where express hands over the router's next and this one
// is a different object on both sides, so what is compared is what it does rather than what it is
app.get(
    "/identity-in-a-route",
    (req, res, next) => {
        res.format({
            default: (rq, rs, given) => rs.json({ isFunction: typeof given === "function" })
        });
    },
    caught
);

app.use((err, req, res, next) => {
    res.status(err.status || 500).json({ hit: "the app error handler", status: err.status, types: err.types });
});

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/in-a-route", "/plain", "/identity", "/identity-in-a-route"]) {
        const res = await fetchTest(`http://localhost:13333${path}`, { headers: { accept: "text/plain" } });
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
