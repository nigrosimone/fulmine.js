// a HEAD runs the param() callbacks of a matching route of another verb, as Express exempts HEAD
// from the method check; the GET route that answers stays native

// Fuzzer seed 3054892626: router.param() plus put("/:p0/:p1/") before get("/list/x1"), and a HEAD
// of /Mixed/list/x1 came back without the header the callback sets. The generic walk had it right,
// the chain of the native HEAD twin skipped the PUT route.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();
app.set("etag", false);

// in the same router
const router = express.Router();
router.param("p0", (req, res, next, value) => {
    res.set("x-param-seen", value);
    next();
});
router.put("/:p0/:p1/", (req, res) => res.send("put"));
router.get("/list/x1", (req, res) => res.json({ ok: 1 }));
router.get("/other/:p0", (req, res) => res.send("other " + req.params.p0));
app.use("/Mixed", router);

// before a mount
app.param("id", (req, res, next, value) => {
    res.set("x-app-param", value);
    next();
});
app.put("/api/:id", (req, res) => res.send("put " + req.params.id));
const api = express.Router();
api.get("/:id", (req, res) => res.send("get " + req.params.id));
app.use("/api", api);

// no param callback anywhere near: nothing to run, the twin stays native
app.put("/plain/:x", (req, res) => res.send("put"));
app.get("/plain/x1", (req, res) => res.send("plain"));

app.listen(13333, async () => {
    if (express.testing) {
        express.testing.expectNative(app, [
            "GET /Mixed/list/x1",
            "GET /Mixed/other/:p0",
            "GET /api/:id",
            "GET /plain/x1"
        ]);
    }
    const answers = await sequential([
        () => fetchTest("http://localhost:13333/Mixed/list/x1", { method: "HEAD" }),
        () => fetchTest("http://localhost:13333/Mixed/list/x1"),
        () => fetchTest("http://localhost:13333/Mixed/other/abc", { method: "HEAD" }),
        () => fetchTest("http://localhost:13333/api/7", { method: "HEAD" }),
        () => fetchTest("http://localhost:13333/api/7"),
        () => fetchTest("http://localhost:13333/plain/x1", { method: "HEAD" })
    ]);
    for (const answer of answers) {
        console.log(
            answer.status,
            answer.headers.get("x-param-seen"),
            answer.headers.get("x-app-param"),
            JSON.stringify(await answer.text())
        );
    }
    process.exit(0);
});
