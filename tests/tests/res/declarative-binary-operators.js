// a non-"+" binary operator inside send() must be evaluated, not pasted together

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
// no etag, so the dynamic bodies stay on the compiled path
app.set("etag", false);

app.get("/sub", (req, res) => res.send(req.query.n - 1));
// eslint-disable-next-line eqeqeq -- the loose comparison operator is what is under test
app.get("/eq", (req, res) => res.send(req.query.a == "x"));
app.get("/concat", (req, res) => res.send("x" + req.query.n + "y"));

// pure defaults, so the literal case rides the compiled path too
const app2 = express();
app2.get("/literal", (req, res) => res.send("a" - 1));

app.listen(13333, () => {
    app2.listen(13334, async () => {
        for (const url of [
            "http://localhost:13333/sub?n=5",
            "http://localhost:13333/eq?a=x",
            "http://localhost:13333/concat?n=5",
            "http://localhost:13334/literal"
        ]) {
            const res = await fetchTest(url);
            console.log(await res.text());
        }
        process.exit(0);
    });
});
