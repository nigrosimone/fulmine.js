// a req.url rewrite inside a prefix mount: the rest of the routing sees the rejoined url, and the
// INSPECT
// 404 page prints the pathname of originalUrl, which a rewrite never changes

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();

app.use("/found", (req, res, next) => {
    req.url = "/target?x=1";
    next();
});

app.get("/found/target", (req, res) => {
    res.json({ query: req.query, url: req.url, originalUrl: req.originalUrl });
});

app.use("/gone", (req, res, next) => {
    req.url = "/nowhere?x=2";
    next();
});

// the whole path consumed: router 2.3 rejoins the assigned url as it is (#206), so "/found/target"
// answers above; router 2.2 stripped its first character and landed here
app.get("/foundtarget", (req, res) => {
    res.json({ mangled: true, query: req.query, url: req.url });
});

// a remainder under the mount: the rejoin is clean and routes to the mount's own path
app.use("/clean", (req, res, next) => {
    req.url = "/target?x=3";
    next();
});

app.get("/clean/target", (req, res) => {
    res.json({ clean: true, query: req.query, url: req.url, originalUrl: req.originalUrl });
});

// inside a mounted router the assigned url routes as it is: the inner /target answers, no
// mangling, because express only restores at the outer layer
const inner = express.Router();
inner.use((req, res, next) => {
    req.url = "/target?x=4";
    next();
});
inner.get("/target", (req, res) => {
    res.json({ inner: true, query: req.query, url: req.url, baseUrl: req.baseUrl });
});
app.use("/mounted", inner);

// nothing inside the router matches the rewrite, so the walk falls back out: rejoined as it is,
// "/fall/nowhere" matches nothing outside either
const fallout = express.Router();
fallout.use((req, res, next) => {
    req.url = "/nowhere?x=5";
    next();
});
app.use("/fall", fallout);

app.get("/fallnowhere", (req, res) => {
    res.json({ fell: true, query: req.query, url: req.url });
});

// and the same fall-through with nothing outside either, for the 404 text
const lost = express.Router();
lost.use((req, res, next) => {
    req.url = "/missing?x=6";
    next();
});
app.use("/lost", lost);

// a rewrite to the root of a mount that took the whole path: the invented "/" goes again, so the
// rest of the routing sees "/root?x=7"
app.use("/root", (req, res, next) => {
    req.url = "/?x=7";
    next();
});
app.get("/root", (req, res) => {
    res.json({ root: true, query: req.query, url: req.url });
});

// the same from inside a mounted router
const toRoot = express.Router();
toRoot.use((req, res, next) => {
    req.url = "/";
    next();
});
app.use("/inner-root", toRoot);
app.get("/inner-root", (req, res) => {
    res.json({ innerRoot: true, url: req.url });
});

app.listen(13763, async () => {
    console.log("Server is running on port 13763");

    const responses = await sequential([
        () => fetchTest("http://localhost:13763/found").then((res) => res.text()),
        () => fetchTest("http://localhost:13763/gone").then((res) => res.text()),
        () => fetchTest("http://localhost:13763/gone?a=b").then((res) => res.text()),
        () => fetchTest("http://localhost:13763/clean/sub").then((res) => res.text()),
        () => fetchTest("http://localhost:13763/mounted").then((res) => res.text()),
        () => fetchTest("http://localhost:13763/fall").then((res) => res.text()),
        () => fetchTest("http://localhost:13763/lost").then((res) => res.text()),
        () => fetchTest("http://localhost:13763/root").then((res) => res.text()),
        () => fetchTest("http://localhost:13763/inner-root").then((res) => res.text())
    ]);

    console.log(responses);

    process.exit(0);
});
