// the automatic OPTIONS reply lists the verbs of the router that answers, not of the whole request
//
// Express keeps that list per router: a mounted router that reaches the end of its own stack
// answers with what it knows, and what the router above it declared for the same path never
// reaches the header. Collecting the verbs on the request instead made a POST declared outside the
// mount appear in a reply written inside it.
// Found by fuzzing route tables against express.

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const outer = express.Router();
// declared before the mount, and matching the same path the mounted router answers
outer.post("/me/{:o}", (req, res) => res.json({ r: "outer post", params: req.params }));
const inner = express.Router();
inner.get("/list", (req, res) => res.json({ r: "inner get" }));
outer.use("/me", inner);
app.use("/:p/users/b", outer);

// a mount whose router answers nothing for this path, so the reply falls back to the app's own
const empty = express.Router();
empty.get("/only", (req, res) => res.json({ r: "empty get" }));
app.use("/fallback", empty);
app.put("/fallback/other", (req, res) => res.json({ r: "app put" }));

// and one plain route, where there is no mount in the way at all
app.get("/plain", (req, res) => res.json({ r: "plain get" }));
app.delete("/plain", (req, res) => res.json({ r: "plain delete" }));

app.use((req, res) => res.status(404).send("no route"));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const cases = [
        ["OPTIONS", "/x/users/b/me/list"],
        ["OPTIONS", "/x/users/b/me/other"],
        ["GET", "/x/users/b/me/list"],
        ["POST", "/x/users/b/me/list"],
        ["OPTIONS", "/fallback/other"],
        ["OPTIONS", "/fallback/only"],
        ["OPTIONS", "/plain"],
        ["OPTIONS", "/nothing"]
    ];

    for (const [method, path] of cases) {
        const res = await fetchTest(`http://localhost:13333${path}`, { method });
        console.log(method, path, res.status, await res.text());
    }

    process.exit(0);
});
