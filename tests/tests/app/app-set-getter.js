// must treat app.set(key) with one argument as a getter

const express = require("express");

const app = express();

app.set("my setting", "hello");

// reading must not disturb what was stored
console.log("set(key) returns: " + app.set("my setting"));
console.log("still there: " + app.get("my setting"));

// a built-in setting reads the same way
console.log("subdomain offset: " + app.set("subdomain offset"));

// an explicit undefined is still a write, so this clears it
app.set("my setting", undefined);
console.log("after writing undefined: " + app.get("my setting"));

// reading something never set is undefined, not an error
console.log("never set: " + app.set("no such setting"));

process.exit(0);
