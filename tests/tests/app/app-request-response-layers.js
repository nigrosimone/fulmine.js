// test that app.request/app.response are per-app layers: extending one app does not touch
// another, a mounted sub-app inherits the parent's extensions and can override them

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app1 = express();
const app2 = express();
const app3 = express();

app1.request.foobar = function () {
    return "tobi";
};
app1.response.shout = function (str) {
    this.send(str.toUpperCase());
};
app2.response.shout = function (str) {
    this.send(str + "!");
};

app1.use("/sub", app2);

app1.get("/", (req, res) => res.shout(req.foobar()));
app2.get("/", (req, res) => res.shout("foo"));
// registered on the parent under the mount path: the parent's layer must apply, not app2's
app1.get("/sub/foo", (req, res) => res.shout("foo"));
// app2 inherits foobar from app1 through the mount
app2.get("/inherited", (req, res) => res.shout(req.foobar()));

// app3 was never extended, so req.foobar must not exist there
app3.get("/", (req, res) => res.send(typeof req.foobar));
app3.use((err, req, res, next) => res.status(500).send("error: " + err.message));

app1.listen(13333, () => {
    app3.listen(13334, async () => {
        for (const path of ["/", "/sub", "/sub/foo", "/sub/inherited"]) {
            const res = await fetchTest("http://localhost:13333" + path);
            console.log(path, "->", await res.text());
        }
        const res = await fetchTest("http://localhost:13334/");
        console.log("app3 / ->", await res.text());
        process.exit(0);
    });
});
