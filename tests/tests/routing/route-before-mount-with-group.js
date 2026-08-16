// a route written before a mount keeps its turn when its path holds an optional group or a wildcard
//
// The overlap analysis decides whether µWS may answer a mounted leaf itself, and it read a segment
// as the text it is written as. `{:opt}` and `*splat` match more than the text they are spelled
// with, so a route holding one was judged unable to answer paths it plainly answers, the mounted
// leaf was registered natively, and µWS jumped straight to it: the earlier route never had its turn
// while express gave it one.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// an optional group before the mount
const withGroup = express.Router();
withGroup.get("/{:o}/:p", (req, res) => res.json({ r: "early group", params: req.params }));
const groupNested = express.Router();
groupNested.get("/:leaf", (req, res) => res.json({ r: "mounted", params: req.params }));
withGroup.use("/x1", groupNested);
app.use("/group", withGroup);

// a wildcard before the mount, which also matches more segments than it is written with
const withSplat = express.Router();
withSplat.get("/*rest", (req, res) => res.json({ r: "early splat", params: req.params }));
const splatNested = express.Router();
splatNested.get("/:leaf", (req, res) => res.json({ r: "mounted", params: req.params }));
withSplat.use("/x2", splatNested);
app.use("/splat", withSplat);

// and the plain case the analysis already got right, so the fix did not widen into it
const plain = express.Router();
plain.get("/other/:p", (req, res) => res.json({ r: "early plain", params: req.params }));
const plainNested = express.Router();
plainNested.get("/:leaf", (req, res) => res.json({ r: "mounted", params: req.params }));
plain.use("/x3", plainNested);
app.use("/plain", plain);

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const path of [
        "/group/x1/leaf",
        "/group/other/leaf",
        "/splat/x2/leaf",
        "/splat/x2/a/b",
        "/plain/x3/leaf",
        "/plain/other/leaf"
    ]) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
