// must offer an ESM importer the same named exports as Express

const express = require("express");
const path = require("path");
const { pathToFileURL } = require("url");

// This one is worth explaining, because it looks like it is testing nothing.
//
// Node decides which named exports a CommonJS module can offer `import { x } from "pkg"` by reading
// the file as text with cjs-module-lexer. It executes nothing: it looks for `module.exports.name =`
// and similar shapes. So an export assigned through a local alias, `const alias = main; alias.x = y`,
// is perfectly real to require() and invisible to import.
//
// This project had exactly that, and nothing caught it, because every other test is CommonJS. The
// only thing that had been keeping named imports working was a block of `exports.x = ...` at the
// bottom of src/index.js, which was dead for require() and doing the whole job for import, and
// which was removed for looking dead.

// the harness rewrites the require above, so which module this is has to be decided at run time
const isFulmine = !!express().uwsApp;
const specifier = isFulmine ? pathToFileURL(path.join(__dirname, "../../../src/index.js")).href : "express";

// what both packages offer, and what the README says they offer
const EXPECTED = ["Router", "application", "json", "raw", "request", "response", "static", "text", "urlencoded"];

(async () => {
    const namespace = await import(specifier);

    console.log("default export is the factory:", typeof namespace.default === "function");
    for (const name of EXPECTED) {
        console.log(`  ${name}: ${typeof namespace[name]}`);
    }

    // not merely present: usable, since the lexer could name something that is undefined at run time
    const router = namespace.Router();
    console.log("Router from the namespace builds a router:", typeof router.use === "function");
    console.log("json from the namespace builds a middleware:", typeof namespace.json() === "function");

    // express.Route is the one Express has and this does not, listed as missing in the README. Asked
    // of each package rather than compared, so that closing the gap makes this fail and say so.
    console.log(
        "Route exported as this package exports it:",
        isFulmine ? !("Route" in namespace) : "Route" in namespace
    );

    // require destructuring is the CommonJS half of the same question
    const { Router: RouterFromRequire, json: jsonFromRequire } = require(
        isFulmine ? "../../../src/index.js" : "express"
    );
    console.log(
        "require destructuring works:",
        typeof RouterFromRequire === "function" && typeof jsonFromRequire === "function"
    );

    process.exit(0);
})();
