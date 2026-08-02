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
// parsers all hang off the same function that creates an app. Naming that shape here is what
// lets the assignments below be checked rather than waved through.
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
const fulmine = /** @type {any} */ (Application);

// converts router to a function and makes it callable
fulmine.Router = function (options) {
    const router = new Router(options);
    const fn = function (req, res, next) {
        router._routeRequest(req, res, 0).then((routed) => {
            if (!routed) {
                next();
            }
        });
    };
    Object.assign(fn, router);
    Object.setPrototypeOf(fn, Object.getPrototypeOf(router));
    return fn;
};

fulmine.request = Request.prototype;
fulmine.response = Response.prototype;
// the third of the trio, and the one that was missing: adding a method here adds it to every app,
// the same as express.application
fulmine.application = Application.Application.prototype;

fulmine.static = middlewares.static;

fulmine.json = middlewares.json;
fulmine.urlencoded = middlewares.urlencoded;
fulmine.text = middlewares.text;
fulmine.raw = middlewares.raw;

// Everything above is hung off this same object, which is what makes express.Router and the rest
// reachable. A block of `exports.x = ...` used to follow this line and did nothing at all:
// assigning module.exports detaches `exports` from it, so those nine lines wrote to an object
// nobody could reach. express.application was only in that block, which is how it went missing.
module.exports = Application;
