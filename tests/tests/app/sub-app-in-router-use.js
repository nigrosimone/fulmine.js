// an app handed to a Router's use() is a function, not a mount
//
// Only app.use() mounts an app: it sets mountpath and parent, emits "mount" and the app then reads
// its parent's settings. To a Router an app is middleware like any other, with its own settings, no
// parent and "/" as mountpath, so res.render in it has no view engine the parent set. Fulmine
// mounted it either way. Found by tools/fuzz.js, replay with --seed 50374525 --rounds 1.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("view engine", "html");
app.set("custom", "root value");

const describe = (sub) => ({
    viewEngine: sub.get("view engine") ?? null,
    custom: sub.get("custom") ?? null,
    mountpath: sub.mountpath,
    hasParent: sub.parent !== undefined
});

// mounted by app.use: inherits
const viaApp = express();
viaApp.get("/settings", (req, res) => res.json(describe(viaApp)));
app.use("/a", viaApp);

// handed to a Router: does not
const viaRouter = express();
viaRouter.get("/settings", (req, res) => res.json(describe(viaRouter)));
viaRouter.get("/render", (req, res) => res.render("page"));
const router = express.Router();
router.use("/b", viaRouter);
app.use(router);

// the fuzzer's shape: under an optional group, then a route after it renders
const nested = express();
const inner = express.Router();
inner.use("/{:o}", nested);
app.use("/c", inner);
app.get("/c/x", (req, res) => res.render("page"));

// the message, not the stack: the paths in it differ between the two
app.use((err, req, res, next) => res.status(500).send(err.message));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const paths = ["/a/settings", "/b/settings", "/b/render", "/c/x"];
    const outputs = await sequential(
        paths.map((path) => async () => {
            const res = await fetchTest(`http://localhost:13333${path}`);
            return `${path} ${res.status} ${await res.text()}`;
        })
    );
    console.log(outputs.join("\n"));
    process.exit(0);
});
