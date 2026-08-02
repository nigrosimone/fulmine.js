/*
Copyright 2024 dimden.dev
Copyright 2026 Nigro Simone

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// H3App, DeclarativeResponse and _cfg all exist at runtime but are missing from the
// declaration file the package ships, so the module is read through a loose alias
const uWS = require("uWebSockets.js");
const uWSAny = /** @type {any} */ (uWS);
const Application = require("./application.js");
const Router = require("./router.js");
const middlewares = require("./middlewares.js");
const Request = require("./request.js");
const Response = require("./response.js");

try {
    // disable Uwebsockets header
    uWSAny._cfg("999999990007");
} catch (error) {
    // older uWS builds do not expose _cfg; there is nothing to fall back to
}

// The factory doubles as a namespace, the way Express does it: Router, static and the body
// parsers all hang off the same function that creates an app.
//
// Assigned onto module.exports directly, and not through a local alias, because that is what
// decides whether `import { Router } from "fulmine.js"` works at all. Node works out which named
// exports a CommonJS module can offer an ESM importer by reading this file as text with
// cjs-module-lexer, which recognises `module.exports.name =` and cannot see through an alias.
// Nothing is executed to find out, so the runtime value is beside the point.
//
// Which is also why the block of `exports.x = ...` this file used to end with was not the dead
// code it looked like. It was dead for require(), since assigning module.exports detaches
// `exports` from it, and it was doing the entire job for import. Removing it took the named
// imports with it, and nothing failed: the tests are all CommonJS.
/**
 * @type {typeof Application & {
 *   Router: Function,
 *   request: object,
 *   response: object,
 *   application: object,
 *   static: Function,
 *   json: Function,
 *   urlencoded: Function,
 *   text: Function,
 *   raw: Function
 * }}
 */
module.exports = /** @type {any} */ (Application);

// a router is a function too, for the same reason an app is: it has to be callable to be usable as
// middleware
module.exports.Router = function (options) {
    return new Router(options)._asCallable();
};

module.exports.request = Request.prototype;
module.exports.response = Response.prototype;
// the third of the trio: adding a method here adds it to every app, the same as express.application
module.exports.application = Application.Application.prototype;

module.exports.static = middlewares.static;
module.exports.json = middlewares.json;
module.exports.urlencoded = middlewares.urlencoded;
module.exports.text = middlewares.text;
module.exports.raw = middlewares.raw;
