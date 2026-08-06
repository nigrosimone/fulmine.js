// next("router") leaves the whole router, not just the route
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

const router = express.Router();
router.get("/foo", (req, res, next) => {
    res.set("x-hit", "1");
    next("router");
});
router.get("/foo", (req, res) => res.send("failure: same router"));
app.use(router);

app.get("/foo", (req, res) => res.send("success"));

// out of the app's own router there is nothing left, so it answers like an unmatched request
app.get("/alone", (req, res, next) => next("router"));

// the same, with a second route on the path: leaving the router must not fall into it either, and
// this is the shape that a compiled chain gets wrong by treating the exit as "the chain ran out"
app.get("/twice", (req, res, next) => next("router"));
app.get("/twice", (req, res) => res.send("failure: same router"));

// leaving a mounted router hands back to the parent, which carries on after the mount
const mounted = express.Router();
mounted.get("/leave", (req, res, next) => next("router"));
mounted.get("/leave", (req, res) => res.send("failure: same mounted router"));
app.use("/m", mounted);
app.get("/m/leave", (req, res) => res.send("parent after the mount"));

// and from a middleware rather than from a route
const midRouter = express.Router();
midRouter.use((req, res, next) => next("router"));
midRouter.get("/x", (req, res) => res.send("failure: same router"));
app.use("/mid", midRouter);
app.get("/mid/x", (req, res) => res.send("parent after the middleware"));

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/foo", "/alone", "/twice", "/m/leave", "/mid/x"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, res.headers.get("x-hit"), await res.text());
    }

    process.exit(0);
});
