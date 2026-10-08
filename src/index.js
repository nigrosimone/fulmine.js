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

const Application = require("./application.js");
const Router = require("./router.js");
const Route = require("./route.js");
const middlewares = require("./middlewares.js");
const Request = require("./request.js");
const Response = require("./response.js");

try {
    // the compile cache, node 22.8 and up: the next boot skips compiling the same code. Respects
    // NODE_DISABLE_COMPILE_CACHE, and booting without a cache is not an error
    require("node:module").enableCompileCache?.();
} catch (error) {
    // node below 22.8, or a disk the cache cannot be written to
}

// the factory doubles as a namespace, as in Express. Always `module.exports.name = ...`, never
// through an alias: cjs-module-lexer reads this file as text for the ESM named exports
/**
 * @type {typeof Application & {
 *   Router: Function,
 *   Route: typeof Route,
 *   request: object,
 *   response: object,
 *   application: object,
 *   static: Function,
 *   testing: object,
 *   isFulmine: true,
 *   compression: Function,
 *   serverTiming: Function,
 *   json: Function,
 *   urlencoded: Function,
 *   text: Function,
 *   raw: Function
 * }}
 */
module.exports = /** @type {any} */ (Application);

// a router is a function too: it has to be callable to be used as middleware
/** @param {object} [options] the options express.Router() takes */
module.exports.Router = function (options) {
    return new Router(options)._asCallable();
};

// express exports it, and code that builds a route by hand rather than through a router uses it
module.exports.Route = Route;

module.exports.request = Request.prototype;
module.exports.response = Response.prototype;
// adding a method here adds it to every app, the same as express.application
module.exports.application = Application.Application.prototype;

module.exports.static = middlewares.static;
// what listen() decided about each route, as something a test can assert on. See src/testing.js
module.exports.testing = require("./testing.js");
// undefined on express: how code that may run on either tells which one it has
module.exports.isFulmine = true;
// express has none: this is the compression module's options and behaviour, without the install
module.exports.compression = require("./compression.js");
// Server-Timing with the routing verdict in it. See src/server-timing.js
module.exports.serverTiming = require("./server-timing.js");
module.exports.json = middlewares.json;
module.exports.urlencoded = middlewares.urlencoded;
module.exports.text = middlewares.text;
module.exports.raw = middlewares.raw;
