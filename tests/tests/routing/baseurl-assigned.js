// req.baseUrl after a middleware assigns it, in every shape of mount
//
// An assignment lives in the router that made it. Express sets req.baseUrl from the path on
// entering a mount that takes one, each callback of use(path, ...) included, and on the way out a
// router puts back what it found and the router around it resets it to what it read on entry.
// Fulmine kept an assignment for the rest of the request. Found by tools/fuzz.js, replay with
// --seed 1985348794 --rounds 1.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
const show = (tag) => (req, res, next) => {
    (req.seen ??= []).push(`${tag}=${req.baseUrl}`);
    next();
};
const assign = (value) => (req, res, next) => {
    req.baseUrl = value;
    next();
};
const answer = (req, res) => res.json(req.seen ?? []);

// inside a path router, left by next("route")
const r1 = express.Router();
r1.get("/a", assign("/one"), show("in"), (req, res, next) => next("route"));
app.use("/c1", r1);
app.get("/c1/a", show("after"), answer);

// the shape the fuzzer found: two routers deep, left from a route
const outer = express.Router();
const nested = express.Router();
nested.get("/:p1/x1", assign("/assigned"), (req, res, next) => next("route"));
outer.use("/x1/x1/:p0", nested);
app.use("/users/posts", outer);
app.get(/^\/users\/.*/, show("after"), answer);

// at the app level with no mount between, it stays
app.get("/c2", assign("/two"), show("same"), (req, res, next) => next());
app.get("/c2", show("next"), answer);

// use(path, ...) is a layer per callback, each entered from the path
const r3 = express.Router();
r3.use(show("inside"));
app.use("/c3", assign("/three"), show("before"), (req, res, next) => next());
app.use("/c3", r3);
app.get("/c3/x", show("after"), answer);

// a router as a route handler puts back what it found
const r4 = express.Router();
r4.use(assign("/four"), show("inside"));
app.get("/c4", r4, show("after"), answer);

// a router called by hand inside a path layer, a path mount inside it
const r5 = express.Router();
const r5in = express.Router();
r5in.use(show("deep"));
r5.use("/x", r5in);
r5.use(show("router"));
app.use("/c5", assign("/five"), (req, res, next) => next());
app.use("/c5", (req, res, next) => r5(req, res, next));
app.use("/c5", show("after"), answer);

// a path middleware function that assigns
app.use("/c6", assign("/six"));
app.get("/c6/y", show("after"), answer);

// a mount that does not match changes nothing
app.use("/c7", assign("/seven"));
app.use("/nomatch", express.Router());
app.get("/c7/z", show("after"), answer);

// a pathless middleware that assigns keeps it for what follows in the same router
app.use("/c8", (req, res, next) => next());
const r8 = express.Router();
r8.use(assign("/eight"));
r8.get("/w", show("route"), answer);
app.use("/c8", r8);

// use(router, fn): what fn assigns after the router stays
const c9 = express.Router();
c9.use(express.Router(), assign("/as"));
c9.use(show("after"));
c9.get("/x", answer);
app.use("/c9", c9);

// a pathless router entered after an assignment: leaving a path layer inside resets to it
const c10 = express.Router();
const c10r = express.Router();
c10r.use("/b", (req, res, next) => next());
c10r.use(show("in"));
c10.use(assign("/as"), c10r);
c10.get("/b", answer);
app.use("/c10", c10);

// and a path layer inside it reads the assignment as its prefix
const c11 = express.Router();
const c11r = express.Router();
c11r.use("/b", show("deep"));
c11.use(assign("/as"), c11r);
c11.get("/b/c", answer);
app.use("/c11", c11);

// a router called by hand puts back what it found
const c12 = express.Router();
const c12r = express.Router();
c12r.use(assign("/r"));
c12.use((req, res, next) => c12r(req, res, next));
c12.use(show("after"));
c12.get("/x", answer);
app.use("/c12", c12);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        "/c1/a",
        "/users/posts/x1/x1/A/b/x1",
        "/c2",
        "/c3/x",
        "/c4",
        "/c5/x/y",
        "/c6/y",
        "/c7/z",
        "/c8/w",
        "/c9/x",
        "/c10/b",
        "/c11/b/c",
        "/c12/x"
    ];
    const outputs = await sequential(
        paths.map((path) => async () => {
            const res = await fetchTest(`http://localhost:13333${path}`);
            return `${path} ${res.status} ${await res.text()}`;
        })
    );
    console.log(outputs.join("\n"));
    process.exit(0);
});
