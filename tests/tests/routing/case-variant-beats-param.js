// a literal route wins over a later parameter route even when the request arrives in another case
// INSPECT
//
// Routing is insensitive by default, so express answers /POSTS with the /posts handler. The native
// µWS router matches bytes: /POSTS reaches no registration of /posts, so it would land on the
// parameter route whose precomputed chain does not contain the literal, and the wrong handler
// would answer. Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// the shape the bug was found in: a literal, then a parameter route on the same segment
app.get("/posts", (req, res) => res.send("literal posts"));
app.get("/:slug", (req, res) => res.send("param slug=" + req.params.slug));

// the same one segment deeper, where the mount path is literal too
app.get("/api/health", (req, res) => res.send("literal health"));
app.get("/api/:id", (req, res) => res.send("param id=" + req.params.id));

// registered in mixed case, so the request in lower case is the case variant this time
app.get("/Reports", (req, res) => res.send("literal Reports"));
app.get("/:other", (req, res) => res.send("param other=" + req.params.other));

// a literal with no letter in it has no other case to arrive in, and keeps its fast path
app.get("/2024", (req, res) => res.send("literal 2024"));
app.get("/:year", (req, res) => res.send("param year=" + req.params.year));

// the earlier route carries a parameter of its own, so what the case hides is a pattern
app.get("/differ/FOO/:x", (req, res) => res.send("cased literal x=" + req.params.x));
app.get("/differ/:user/:x", (req, res) => res.send(`param user=${req.params.user} x=${req.params.x}`));

// written with a trailing slash, and asked for with one. The registration drops the slash, so the
// guard is one character shorter than the path that arrives and used to miss it: "/X1/" went to the
// parameter route while express answered from the literal
app.get("/x1/", (req, res) => res.send("literal x1 slashed"));
app.get("/:p6", (req, res, next) => next("route"));

// and the same inside a mounted router, where the guard has to carry the mount path
const mounted = express.Router();
mounted.get("/list", (req, res) => res.send("mounted literal"));
mounted.get("/:slug", (req, res) => res.send("mounted param slug=" + req.params.slug));
app.use("/mnt", mounted);

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = [
        "/posts",
        "/POSTS",
        "/Posts",
        "/pOsTs",
        "/anything",
        "/api/health",
        "/api/HEALTH",
        "/api/Health",
        "/api/7",
        "/Reports",
        "/reports",
        "/REPORTS",
        "/2024",
        "/2025",
        "/differ/FOO/9",
        "/differ/foo/9",
        "/differ/Foo/9",
        "/differ/bar/9",
        "/x1",
        "/x1/",
        "/X1",
        "/X1/",
        "/mnt/list",
        "/mnt/LIST",
        "/mnt/List",
        "/mnt/other"
    ];

    for (const path of paths) {
        const res = await fetchTest(`http://localhost:13333${path}`);
        console.log(path, res.status, await res.text());
    }

    process.exit(0);
});
