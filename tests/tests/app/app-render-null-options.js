// app.render() with null for the options, which express 5.3 takes as none were given

const express = require("express");

const app = express();
app.set("view engine", "ejs");
app.set("views", "tests/parts");
app.set("env", "production");
app.locals.title = "App Title";
app.locals.message = "App Message";
app.locals.asdf = "app locals value";

app.render("index", null, (err, html) => {
    console.log("null:", err ? err.message : html.includes("App Title"));
    app.render("index", undefined, (err, html) => {
        console.log("undefined:", err ? err.message : html.includes("App Title"));
        app.render("index", { title: "Own" }, (err, html) => {
            console.log("object:", err ? err.message : html.includes("Own"));
            process.exit(0);
        });
    });
});
