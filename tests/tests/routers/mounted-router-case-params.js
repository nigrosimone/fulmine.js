// a router reached through a mount written in another case still reads its parameters
//
// The mount belongs to the router that declares it, so an insensitive app enters /list through
// /LIST whatever the mounted router thinks about case. What runs below has to see the path with
// that prefix taken off, and the prefix was being looked for under the inner router's rules, so a
// case sensitive router mounted on an insensitive app ran with empty params.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const sensitive = express.Router({ caseSensitive: true });
sensitive.get("/:p0", (req, res) =>
    res.json({ where: "sensitive", params: req.params, base: req.baseUrl, url: req.url })
);
app.use("/list", sensitive);

// a router that cares about the end of a path rather than its case, mounted the same way
const strictly = express.Router({ strict: true });
strictly.get("/:id/edit", (req, res) => res.json({ where: "strict", params: req.params, base: req.baseUrl }));
app.use("/Items", strictly);

// and one with a parameter in the mount itself, so the prefix taken off is not a constant
const plain = express.Router();
plain.get("/:a/:b", (req, res) => res.json({ where: "plain", params: req.params, base: req.baseUrl }));
app.use("/deep/:mid", plain);

// two mounts deep, the outer sensitive and the inner not
const outer = express.Router({ caseSensitive: true });
const inner = express.Router();
inner.get("/:leaf", (req, res) => res.json({ where: "nested", params: req.params, base: req.baseUrl }));
outer.use("/in", inner);
app.use("/Outer", outer);

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        "/list/X-Y",
        "/LIST/X-Y",
        "/List/x",
        "/Items/7/edit",
        "/ITEMS/7/edit",
        "/items/7/edit",
        "/deep/A/b/c",
        "/DEEP/A/b/c",
        "/Outer/in/leaf",
        "/OUTER/in/leaf",
        "/Outer/IN/leaf"
    ];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
