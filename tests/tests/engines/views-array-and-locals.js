// "views" as a list of directories, searched in order, and the precedence of render locals
// INSPECT

const path = require("path");
const express = require("express");
const { fetchTest } = require("../../helpers.js");

const app = express();

app.engine("html", (filePath, options, callback) => {
    callback(null, `${path.basename(path.dirname(filePath))} says ${options.user}`);
});
app.set("view engine", "html");
// the first directory that has the template wins, the second catches what the first lacks
app.set("views", [path.join(__dirname, "../../parts/views-a"), path.join(__dirname, "../../parts/views-b")]);

app.locals.user = "app";

app.get("/both", (req, res) => res.render("both"));
app.get("/only-b", (req, res) => res.render("only-b"));
app.get("/missing", (req, res) => res.render("nowhere"));

// res.locals beats app.locals, and what render() is given beats both
app.get("/res-locals", (req, res) => {
    res.locals.user = "res";
    res.render("both");
});
app.get("/render-locals", (req, res) => {
    res.locals.user = "res";
    res.render("both", { user: "call" });
});

app.use((err, req, res, next) => res.status(500).send(`error: ${err.message}`));

app.listen(13333, async () => {
    console.log("Server is running on port 13333");

    for (const route of ["/both", "/only-b", "/missing", "/res-locals", "/render-locals"]) {
        const res = await fetchTest(`http://localhost:13333${route}`);
        console.log(route, res.status, await res.text());
    }

    process.exit(0);
});
