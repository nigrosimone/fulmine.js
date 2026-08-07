// a route written before a mount keeps its turn, whatever method it was written with
//
// The native router jumps straight to a route, so everything registered before it that could also
// match has to be in the chain computed for it. A mount is registered ALL, because what lives under
// it can answer any method, and its chain is computed once for all of them: an earlier route of
// some other method belongs in the chain of the leaves that share its method and in no other, and
// one chain cannot say that. It was dropped, so µWS handed the request to a literal route inside
// the mounted router and the parameter route written before the mount never had its turn.
// Found by fuzzing route tables against express.
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("etag", false);

const router = express.Router({ caseSensitive: true });
// registered first, and with a method of its own, which is what used to make it disappear
router.get("/{:o1}/*splat2", (req, res) => res.json({ hit: "the param route", params: req.params }));
router.post("/{:o1}/*splat2", (req, res) => res.json({ hit: "the param route, posted" }));

const nested = express.Router();
// a literal, so µWS can be given the whole path and jump to it
nested.get("/x1", (req, res) => res.json({ hit: "the literal inside the mount" }));
nested.put("/x1", (req, res) => res.json({ hit: "the literal, put" }));
router.use("/x1/x1/Mixed", nested);

app.use("/b", router);

// after everything, so an answer from here means the router above declined
app.get("/b/*splat15", (req, res) => res.json({ hit: "the app route" }));
app.all("/b/*splat15", (req, res) => res.json({ hit: "the app route, any method" }));
app.use((req, res) => res.status(404).json({ hit: "nothing" }));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const cases = [
        // the one the fuzzer found: the literal under the mount is what µWS matches, and the
        // parameter route before the mount is what express answers with
        ["GET", "/b/x1/x1/Mixed/x1"],
        ["PUT", "/b/x1/x1/Mixed/x1"],
        ["POST", "/b/x1/x1/Mixed/x1"],
        // paths that never reach the mount, where the parameter route answered all along
        ["GET", "/b/a/b"],
        ["GET", "/b/a/b/c/d"],
        // and one segment, which the parameter route needs two of
        ["GET", "/b/a"]
    ];

    for (const [method, url] of cases) {
        const res = await fetchTest(`http://localhost:13333${url}`, { method });
        console.log(method, url, res.status, await res.text());
    }

    process.exit(0);
});
