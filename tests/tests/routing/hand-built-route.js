// A Route built by hand and dispatched from a middleware, which is what express exports Route for.
// What a handler returns is waited for here as the router waits for it elsewhere: a rejection
// reaches the error handler, a bare one gets the error express invents, and a thenable counts too.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);
app.set("env", "production");

const mount = (path, build) => {
    const route = new express.Route(path);
    build(route);
    app.use(path, (req, res, next) => route.dispatch(req, res, next));
};

mount("/reject", (route) =>
    route.get(async () => {
        throw new Error("rejected");
    })
);
// a rejection with nothing in it, which is the one express names itself
mount("/bare", (route) => route.get(() => Promise.reject()));
mount("/thenable", (route) => route.get(() => ({ then: (ok, bad) => bad(new Error("thenable")) })));
mount("/throw", (route) =>
    route.get(() => {
        throw new Error("thrown");
    })
);
mount("/resolve", (route) => route.get(async (req, res) => res.send("async ok")));
// the error handler written on the route itself catches before the app's
mount("/caught", (route) => {
    route.get(async () => {
        throw new Error("caught here");
    });
    route.all((err, req, res, next) => res.status(500).send("route handler: " + err.message));
});
// next() hands on to the verb after it, next("route") leaves the route with nothing answered
mount("/chain", (route) => {
    route.all((req, res, next) => {
        res.set("X-Lead", "1");
        next();
    });
    route.get((req, res) => res.send("chained " + req.route.path));
});
mount("/skip", (route) => {
    route.get((req, res, next) => next("route"));
    route.get((req, res) => res.send("never"));
});
mount("/verbs", (route) => {
    route.get((req, res) => res.send("got"));
    route.post((req, res) => res.send("posted"));
});

app.use((req, res) => res.status(404).send("none"));
app.use((err, req, res, next) => res.status(500).send("app handler: " + err.message));

const asks = [
    ["GET", "/reject"],
    ["GET", "/bare"],
    ["GET", "/thenable"],
    ["GET", "/throw"],
    ["GET", "/resolve"],
    ["GET", "/caught"],
    ["GET", "/chain"],
    ["GET", "/skip"],
    ["GET", "/verbs"],
    ["POST", "/verbs"],
    ["HEAD", "/verbs"],
    ["PUT", "/verbs"]
];

app.listen(13333, async () => {
    console.log("Server is running on port 13333");
    await sequential(
        asks.map(([method, path]) => async () => {
            const res = await fetchTest("http://localhost:13333" + path, { method });
            console.log(method, path, res.status, res.headers.get("x-lead"), await res.text());
        })
    );
    process.exit(0);
});
