// a sub-app renders with an engine only its parent registered
//
// The fuzzer found this: the sub-app sets no engine of its own, so on mount its engines chain to
// the parent's. Handing the view a copy of that object instead of the object broke the chain, and
// the view then did what express does when it knows no engine for an extension, which is require()
// a module named after it. The failure is a "Cannot find module" from inside the framework rather
// than the missing view the request actually asked about.
// INSPECT

const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();
app.set("views", "tests/parts");
app.set("view engine", "html");
app.engine("html", (filePath, options, callback) => {
    callback(null, `rendered ${filePath.split(/[\\/]/).pop()} for ${options.who}`);
});

// nothing of its own: no engine, no view engine, no views
const bare = express();
bare.get("/known", (req, res) => res.render("index", { who: "bare" }));
bare.get("/missing", (req, res) => res.render("not-there", { who: "bare" }));

// its own engine for the same extension wins over the parent's
const own = express();
own.engine("html", (filePath, options, callback) => callback(null, "the sub-app's own engine"));
own.get("/known", (req, res) => res.render("index", { who: "own" }));

app.use("/bare", bare);
app.use("/own", own);

app.get("/known", (req, res) => res.render("index", { who: "parent" }));

app.use((err, req, res, next) => res.status(500).send("error: " + err.message.split("\n")[0]));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const url of ["/known", "/bare/known", "/own/known", "/bare/missing"]) {
        const res = await fetchTest(`http://localhost:13333${url}`);
        console.log(url, res.status, (await res.text()).replace(/[A-Za-z]:[\\/][^"]*?tests/g, "<root>/tests"));
    }

    process.exit(0);
});
