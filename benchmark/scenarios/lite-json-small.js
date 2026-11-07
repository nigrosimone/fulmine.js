"use strict";

// Brotli is negotiated, but the response stays below the default compression threshold.
module.exports = require("../lite-json.js")({ name: "small", count: 1, encoding: "br" });
