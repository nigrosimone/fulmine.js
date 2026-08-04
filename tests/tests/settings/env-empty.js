// test that an empty NODE_ENV still reads as development, as express defaults it
// INSPECT

process.env.NODE_ENV = "";

const express = require("express");

const app = express();
console.log("env:", app.get("env"));

process.exit(0);
