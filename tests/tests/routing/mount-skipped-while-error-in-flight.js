// a mount is stepped over while an error is in flight, and its settings never answer
//
// A mounted router or application is handed the request through a handle that takes three
// arguments, so express walks past it when an error is already there: what a mount catches is what
// it raised itself. Entering it ran the error handlers written inside, and a mounted application
// stayed req.app afterwards, since only Application#use puts the outer one back. The error page
// then answered with the inner application's etag setting.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", "strong");

const seen = [];

// every mount below is built after the route that fails, so its error handler is written after the
// error and would be reachable if the mount were entered at all

// mounted on a plain Router, which is the shape that leaves the inner application in place: it
// answers the error page, and its etag setting is the default weak one rather than the app's
const outer = express.Router();
outer.get("/boom", (req, res, next) => next(new Error("raised before the mount")));
const inner = express();
inner.get("/*rest", (req, res) => res.send("inner answered"));
outer.use("/", inner);
app.use("/plain", outer);

// a mounted router holding an error handler of its own, which must not catch this one
app.get("/mount/boom", (req, res, next) => next(new Error("raised before the mount")));
const holder = express.Router();
holder.use((err, req, res, next) => {
    seen.push("inside the mount");
    next(err);
});
holder.get("/x", (req, res) => res.send("x"));
app.use("/mount", holder);

// and the same with an application, where req.app is put back on the way out
app.get("/app/boom", (req, res, next) => next(new Error("raised before the mount")));
const holderApp = express();
holderApp.use((err, req, res, next) => {
    seen.push("inside the application");
    next(err);
});
holderApp.get("/x", (req, res) => res.send("x"));
app.use("/app", holderApp);

// the same shape one more time, arranged so the optimizer compiles a chain for the leaf inside the
// mount: the chain walks into the mount rather than entering it, which is a second place to say it
app.use("/compiled", (req, res, next) => next(new Error("raised before the mount")));
const compiled = express();
compiled.use((err, req, res, next) => {
    seen.push("inside the compiled mount");
    next(err);
});
compiled.get("/leaf", (req, res) => res.send("leaf"));
app.use("/compiled", compiled);

// what a mount raises itself is still its own to catch
const catching = express.Router();
catching.get("/own", (req, res, next) => next(new Error("raised inside the mount")));
catching.use((err, req, res, next) => {
    seen.push("caught its own");
    next(err);
});
app.use("/catch", catching);

app.use((err, req, res, next) => res.status(500).send("handler: " + err.message));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of [
        "/plain/boom",
        "/mount/boom",
        "/app/boom",
        "/compiled/leaf",
        "/catch/own",
        "/mount/x",
        "/plain/anything"
    ]) {
        seen.length = 0;
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, "etag:", res.headers.get("etag"), await res.text(), seen);
    }

    process.exit(0);
});
