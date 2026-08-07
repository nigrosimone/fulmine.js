// a layer written before a mount keeps its turn inside the mount too
//
// A mount covers everything under its path, so what an earlier layer can answer is a question about
// a subtree and not about the mount point. "/a" and "/:p0/:p1/:p2" match none of each other's text,
// which is what the chain was judged on, and both answer "/a/x/y": µWS jumped straight to the leaf
// registered under "/a" and the three-parameter layer written before it never had its turn.
//
// The reverse cases are here too, because the fix must not take the native registration away from
// leaves an earlier layer could never reach: one segment too few, one too many, and another method.
// Found by fuzzing route tables against express.
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// three segments, so it does not match "/a" and does match everything three deep under it
const deeperMount = express.Router();
deeperMount.get("/:rest", (req, res) => res.json({ hit: "the mount written first", params: req.params }));
app.use("/:p0/:p1/:p2", deeperMount);

// a plain route of the same shape, which express tries in this order too
app.get("/:q0/:q1/:q2/:q3", (req, res) => res.json({ hit: "the route written first", params: req.params }));

// one segment deeper than any leaf below, so it can never answer for them
app.get("/:z0/:z1/:z2/:z3/:z4/:z5", (req, res) => res.json({ hit: "too deep to matter" }));

// another method, which express does not try for a GET
app.post("/:m0/:m1/:m2", (req, res) => res.json({ hit: "the wrong method" }));

const mounted = express.Router();
// literals µWS can be given whole, which is what made it jump past everything above
mounted.get("/posts/x", (req, res) => res.json({ hit: "three deep, inside the mount" }));
mounted.get("/posts/x/y", (req, res) => res.json({ hit: "four deep, inside the mount" }));
mounted.get("/posts", (req, res) => res.json({ hit: "two deep, inside the mount" }));
app.use("/a", mounted);

app.use((req, res) => res.status(404).json({ hit: "nothing" }));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const cases = [
        // three deep: the mount written first answers, not the leaf
        ["GET", "/a/posts/x"],
        // four deep: the plain route written first answers
        ["GET", "/a/posts/x/y"],
        // two deep: nothing written before reaches this, so the leaf answers
        ["GET", "/a/posts"],
        // the same paths under a first segment the earlier layers match just as well
        ["GET", "/b/posts/x"],
        // and with the method the leaves do not serve
        ["POST", "/a/posts/x"],
        ["POST", "/a/posts"]
    ];

    for (const [method, url] of cases) {
        const res = await fetchTest(`http://localhost:13333${url}`, { method });
        console.log(method, url, res.status, await res.text());
    }

    process.exit(0);
});
