// app.set("env") must not overwrite an explicitly configured "view cache"

const express = require("express");

const app = express();
app.enable("view cache");
app.set("env", "development");
console.log("enable then env=development:", app.get("view cache"), app.enabled("view cache"));

const app2 = express();
app2.disable("view cache");
app2.set("env", "production");
console.log("disable then env=production:", app2.get("view cache"), app2.enabled("view cache"));

console.log("env reads back:", app2.get("env"));

process.exit(0);
