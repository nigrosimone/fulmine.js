// a route written before a mount that answers the mount point itself
//
// The chain computed for a mount is inherited by every path under it, and a route that is not
// itself a mount answers the mount point rather than the subtree. In the chain it ran for the whole
// of it, so router.all("/:p1") answered a request for /posts/a-b, which are two segments and belong
// to the router mounted at /posts. A route of another method was already refusing the mount here.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const router = express.Router();
// all(), because a route of this router's own method took the other road and was refused already
router.all("/:p1", (req, res) => res.send("one segment, p1=" + req.params.p1));
const nested = express.Router();
nested.get("/a-b", (req, res) => res.send("the mounted router"));
router.use("/posts", nested);
app.use("/list", router);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of ["/list/posts/a-b", "/list/posts", "/list/other", "/list/posts/nothing"]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
