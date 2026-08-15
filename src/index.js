/*
Copyright 2024 dimden.dev
Copyright 2026 Nigro Simone

This file is derived from Ultimate Express and has been modified.

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
const Route = require("./route.js");
const middlewares = require("./middlewares.js");
const Request = require("./request.js");
const Response = require("./response.js");

try {
    // disable Uwebsockets header
    uWSAny._cfg("999999990007");
} catch (error) {
    // older uWS builds do not expose _cfg; there is nothing to fall back to
}

try {
    // the compile cache, in node since 22.8: the next boot of the same code skips compiling it.
    // Asked for here because in practice the framework is the entry point of the application
    // using it. Respects NODE_DISABLE_COMPILE_CACHE, and booting without a cache is not an error
    require("node:module").enableCompileCache?.();
} catch (error) {
    // node below 22.8, or a disk the cache cannot be written to
}

// The factory doubles as a namespace, as in Express: Router, static and the body parsers hang off
// the function that creates an app.
//
// Written as `module.exports.name = ...` and never through an alias: cjs-module-lexer reads this
// file as text to decide which named exports an ESM importer gets, and it cannot see through one.
// Nothing here is executed to find that out.
/**
 * @type {typeof Application & {
 *   Router: Function,
 *   Route: typeof Route,
 *   request: object,
 *   response: object,
 *   application: object,
 *   static: Function,
 *   testing: object,
 *   compression: Function,
 *   serverTiming: Function,
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

// express exports it, and code that builds a route by hand rather than through a router uses it
module.exports.Route = Route;

module.exports.request = Request.prototype;
module.exports.response = Response.prototype;
// the third of the trio: adding a method here adds it to every app, the same as express.application
module.exports.application = Application.Application.prototype;

module.exports.static = middlewares.static;
// what listen() decided about each route, as something a test can assert on rather than something
// to read in a terminal. See src/testing.js
module.exports.testing = require("./testing.js");
// not one of express's, since express has none: the compression module is what everyone installs
// instead, and this is that middleware's options and behaviour without the install
module.exports.compression = require("./compression.js");
// Server-Timing with the routing verdict in it, which no other framework can report because no
// other framework has two routes to tell apart. See src/server-timing.js
module.exports.serverTiming = require("./server-timing.js");
module.exports.json = middlewares.json;
module.exports.urlencoded = middlewares.urlencoded;
module.exports.text = middlewares.text;
module.exports.raw = middlewares.raw;
