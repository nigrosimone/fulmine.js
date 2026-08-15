// must reach a later route in a mounted router when the one before it hands over

// µWS picks a route by specificity where Express picks by registration order, and the chain
// computed for a native route carries only what runs in front of it. A literal route inside a
// mounted router was handed to µWS without asking whether anything after it could answer the same
// path, so `next()` walked out of the mount and the request was answered 404 where Express answers
// it with the later route. Found by tools/fuzz.js, replay with --seed 221940161 --rounds 1.

const express = require("express");
const { fetchTest, sequential } = require("../../helpers.js");

const app = express();

// a parameter route after a literal one, which is the shape that broke
const params = express.Router();
params.get("/a", (req, res, next) => next());
params.get("/:x", (req, res) => res.send("param " + req.params.x));
app.use("/params", params);

// next("route") leaves the route rather than the router, and has to land in the same place
const leaves = express.Router();
leaves.get("/a", (req, res, next) => next("route"));
leaves.get("/:x", (req, res) => res.send("left the route " + req.params.x));
app.use("/leaves", leaves);

// a wildcard is the same question with another pattern
const wild = express.Router();
wild.get("/a", (req, res, next) => next());
wild.get("/*rest", (req, res) => res.send("wildcard"));
app.use("/wild", wild);

// case sensitivity was in the shape the fuzzer found, and must not change the answer
const sensitive = express.Router({ caseSensitive: true });
sensitive.get("/Mixed", (req, res, next) => next("route"));
sensitive.get("/*path/", (req, res) => res.send("mixed wildcard"));
app.use("/list/a", sensitive);

// two literals still answer from the second one, which always worked: both are on one µWS route
const literals = express.Router();
literals.get("/a", (req, res, next) => next());
literals.get("/a", (req, res) => res.send("second literal"));
app.use("/literals", literals);

// and a route that answers is still the one that answers, rather than falling through
const answers = express.Router();
answers.get("/a", (req, res) => res.send("first wins"));
answers.get("/:x", (req, res) => res.send("should not run"));
app.use("/answers", answers);

// nothing after it can match, so this one keeps the fast path and still answers
const alone = express.Router();
alone.get("/a", (req, res) => res.send("alone"));
app.use("/alone", alone);

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    const answersFor = await sequential([
        () => fetchTest("http://localhost:13333/params/a"),
        () => fetchTest("http://localhost:13333/leaves/a"),
        () => fetchTest("http://localhost:13333/wild/a"),
        () => fetchTest("http://localhost:13333/list/a/Mixed"),
        () => fetchTest("http://localhost:13333/literals/a"),
        () => fetchTest("http://localhost:13333/answers/a"),
        () => fetchTest("http://localhost:13333/alone/a"),
        // nothing answers this one, on either server
        () => fetchTest("http://localhost:13333/alone/b")
    ]);

    for (const response of answersFor) {
        console.log(response.status, JSON.stringify((await response.text()).slice(0, 40)));
    }

    process.exit(0);
});
