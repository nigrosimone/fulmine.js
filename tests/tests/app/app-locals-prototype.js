// test that app.locals is a null-prototype object still carrying settings
// INSPECT

const express = require("express");

const app = express();

console.log("prototype is null:", Object.getPrototypeOf(app.locals) === null);
console.log("has settings:", typeof app.locals.settings);
app.set("title", "Express");
console.log("settings is live:", app.locals.settings.title);
console.log("no Object methods:", app.locals.hasOwnProperty === undefined);

process.exit(0);
